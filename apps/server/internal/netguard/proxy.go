package netguard

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	"golang.org/x/net/proxy"
)

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }

func upstreamDialer(raw string, trusted bool) (func(context.Context, string, string) (net.Conn, error), error) {
	if raw == "" {
		return DialContext, nil
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("invalid proxy address")
	}
	if u.Scheme != "http" && u.Scheme != "https" && u.Scheme != "socks5" && u.Scheme != "socks5h" {
		return nil, errors.New("unsupported proxy scheme")
	}
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := resolve(ctx, host)
		if err != nil {
			return nil, err
		}
		target := net.JoinHostPort(ips[0].Unmap().String(), port)
		proxyHost := u.Hostname()
		proxyPort := u.Port()
		if proxyPort == "" {
			proxyPort = "80"
			if u.Scheme == "https" {
				proxyPort = "443"
			}
			if strings.HasPrefix(u.Scheme, "socks") {
				proxyPort = "1080"
			}
		}
		if !trusted {
			addresses, err := resolve(ctx, proxyHost)
			if err != nil {
				return nil, err
			}
			proxyHost = addresses[0].Unmap().String()
		}
		proxyAddress := net.JoinHostPort(proxyHost, proxyPort)
		base := &net.Dialer{Timeout: 15 * time.Second}
		if strings.HasPrefix(u.Scheme, "socks") {
			var auth *proxy.Auth
			if u.User != nil {
				password, _ := u.User.Password()
				auth = &proxy.Auth{User: u.User.Username(), Password: password}
			}
			dialer, err := proxy.SOCKS5("tcp", proxyAddress, auth, base)
			if err != nil {
				return nil, err
			}
			return dialer.(proxy.ContextDialer).DialContext(ctx, network, target)
		}
		conn, err := base.DialContext(ctx, "tcp", proxyAddress)
		if err != nil {
			return nil, err
		}
		fail := func(err error) (net.Conn, error) { conn.Close(); return nil, err }
		if u.Scheme == "https" {
			tlsConn := tls.Client(conn, &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12})
			if err = tlsConn.HandshakeContext(ctx); err != nil {
				return fail(err)
			}
			conn = tlsConn
		}
		_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
		req, _ := http.NewRequest(http.MethodConnect, "http://"+target, nil)
		if u.User != nil {
			password, _ := u.User.Password()
			req.Header.Set("Proxy-Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(u.User.Username()+":"+password)))
		}
		if err = req.Write(conn); err != nil {
			return fail(err)
		}
		reader := bufio.NewReader(conn)
		response, err := http.ReadResponse(reader, req)
		if err != nil {
			return fail(err)
		}
		if response.StatusCode != 200 {
			return fail(errors.New("upstream proxy refused the tunnel"))
		}
		_ = conn.SetDeadline(time.Time{})
		return &bufferedConn{Conn: conn, reader: reader}, nil
	}, nil
}

// StartProxy confines external downloader requests, redirects and playlist
// fragments to public targets. Configured private upstream proxies may be trusted
// by the operator, but their ultimate destination is still pinned to a public IP.
func StartProxy(parent context.Context, upstream string, trusted bool) (string, func(), error) {
	dial, err := upstreamDialer(upstream, trusted)
	if err != nil {
		return "", nil, err
	}
	return startProxy(parent, dial)
}

func startProxy(parent context.Context, dial func(context.Context, string, string) (net.Conn, error)) (string, func(), error) {
	ctx, cancel := context.WithCancel(parent)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		cancel()
		return "", nil, err
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DialContext = dial
	client := &http.Client{Transport: transport, Timeout: 15 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw := r.URL.String()
		if r.Method == http.MethodConnect {
			raw = "https://" + r.Host
		}
		if err := ValidateURL(r.Context(), raw); err != nil {
			http.Error(w, "Destination blocked", http.StatusForbidden)
			return
		}
		if r.Method == http.MethodConnect {
			target, err := dial(r.Context(), "tcp", r.Host)
			if err != nil {
				http.Error(w, "Tunnel unavailable", 502)
				return
			}
			connection, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				target.Close()
				return
			}
			done := make(chan struct{})
			defer close(done)
			defer target.Close()
			defer connection.Close()
			go func() {
				select {
				case <-ctx.Done():
					target.Close()
					connection.Close()
				case <-done:
				}
			}()
			if _, err = fmt.Fprint(buffer, "HTTP/1.1 200 Connection Established\r\n\r\n"); err != nil {
				return
			}
			if err = buffer.Flush(); err != nil {
				return
			}
			go func() { _, _ = io.Copy(target, buffer.Reader); target.Close() }()
			_, _ = io.Copy(connection, target)
			return
		}
		request := r.Clone(r.Context())
		request.RequestURI = ""
		request.Header = request.Header.Clone()
		for _, name := range []string{"Connection", "Proxy-Connection", "Proxy-Authorization", "Keep-Alive", "TE", "Trailer", "Transfer-Encoding", "Upgrade"} {
			request.Header.Del(name)
		}
		response, err := client.Do(request)
		if err != nil {
			http.Error(w, "Public destination unavailable", 502)
			return
		}
		defer response.Body.Close()
		for key, values := range response.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	})}
	go func() { _ = server.Serve(listener) }()
	closeProxy := func() { cancel(); _ = server.Close(); transport.CloseIdleConnections() }
	return "http://" + listener.Addr().String(), closeProxy, nil
}
