package api

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

type clientVisitor struct {
	count       int
	windowStart time.Time
	lastSeen    time.Time
}

// RateLimiter implements a thread-safe sliding window rate limiter per client IP or key,
// with bounded memory capacity and idle eviction.
type RateLimiter struct {
	mu          sync.Mutex
	visitors    map[string]*clientVisitor
	rate        int
	window      time.Duration
	maxCapacity int
}

const DefaultMaxCapacity = 10000

func NewRateLimiter(rate int, window time.Duration) *RateLimiter {
	rl := &RateLimiter{
		visitors:    make(map[string]*clientVisitor),
		rate:        rate,
		window:      window,
		maxCapacity: DefaultMaxCapacity,
	}

	// Periodic garbage collection for idle clients
	go rl.cleanup(window * 2)

	return rl
}

func (rl *RateLimiter) cleanup(interval time.Duration) {
	ticker := time.NewTicker(interval)
	for range ticker.C {
		rl.mu.Lock()
		now := time.Now()
		for key, v := range rl.visitors {
			if now.Sub(v.lastSeen) > interval {
				delete(rl.visitors, key)
			}
		}
		rl.mu.Unlock()
	}
}

// Allow checks if the given key is allowed under the rate limit.
func (rl *RateLimiter) Allow(key string) (bool, time.Duration) {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	now := time.Now()
	v, exists := rl.visitors[key]
	if !exists || now.Sub(v.windowStart) >= rl.window {
		// Enforce bounded memory: if capacity is reached, evict expired or oldest entry
		if !exists && len(rl.visitors) >= rl.maxCapacity {
			var oldestKey string
			var oldestTime time.Time
			for k, vis := range rl.visitors {
				if now.Sub(vis.lastSeen) >= rl.window {
					delete(rl.visitors, k)
				} else if oldestKey == "" || vis.lastSeen.Before(oldestTime) {
					oldestKey = k
					oldestTime = vis.lastSeen
				}
			}
			if len(rl.visitors) >= rl.maxCapacity && oldestKey != "" {
				delete(rl.visitors, oldestKey)
			}
		}

		rl.visitors[key] = &clientVisitor{
			count:       1,
			windowStart: now,
			lastSeen:    now,
		}
		return true, 0
	}

	v.lastSeen = now
	if v.count < rl.rate {
		v.count++
		return true, 0
	}

	remaining := rl.window - now.Sub(v.windowStart)
	if remaining < 0 {
		remaining = 0
	}
	return false, remaining
}

// Reset clears all visitor records (useful for testing).
func (rl *RateLimiter) Reset() {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	rl.visitors = make(map[string]*clientVisitor)
}

// IsTrustedProxyWithConfig reports whether the remote address is a configured, trusted reverse proxy.
// It accepts environment values directly for deterministic evaluation and testing.
func IsTrustedProxyWithConfig(remoteIP, trustedProxiesEnv, trustProxyEnv string) bool {
	remoteIP = NormalizeIP(remoteIP)
	parsed := net.ParseIP(remoteIP)
	if parsed == nil {
		return false
	}

	// 1. Explicit TRUSTED_PROXIES list (comma-separated IPs/CIDRs)
	if trustedProxiesEnv != "" {
		for _, tp := range strings.Split(trustedProxiesEnv, ",") {
			tp = strings.TrimSpace(tp)
			if tp == "" {
				continue
			}
			if _, cidr, err := net.ParseCIDR(tp); err == nil {
				if cidr.Contains(parsed) {
					return true
				}
			} else {
				cand := net.ParseIP(tp)
				if cand != nil && cand.Equal(parsed) {
					return true
				}
			}
		}
		// If TRUSTED_PROXIES is configured, ONLY addresses matching the list are trusted.
		return false
	}

	// 2. TRUST_PROXY boolean flag defaults to trusting local loopback ONLY.
	// Private network addresses (e.g. 192.168.x.x, 10.x.x.x) are strictly UNTRUSTED by default
	// to prevent spoofing from LAN/VPN peers.
	if strings.EqualFold(trustProxyEnv, "true") {
		return parsed.IsLoopback()
	}

	return false
}

// isTrustedProxy reports whether the remote address is a configured, trusted reverse proxy
// using process environment variables.
func isTrustedProxy(remoteIP string) bool {
	return IsTrustedProxyWithConfig(remoteIP, os.Getenv("TRUSTED_PROXIES"), os.Getenv("TRUST_PROXY"))
}

// NormalizeIP canonicalizes an IP string (handling ports, enclosing brackets, IPv4-mapped IPv6, and standard formats).
func NormalizeIP(rawIP string) string {
	rawIP = strings.TrimSpace(rawIP)
	if host, _, err := net.SplitHostPort(rawIP); err == nil {
		rawIP = host
	}
	rawIP = strings.TrimPrefix(rawIP, "[")
	rawIP = strings.TrimSuffix(rawIP, "]")
	ip := net.ParseIP(rawIP)
	if ip == nil {
		return rawIP
	}
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.String()
}

// GetClientIP extracts the client IP address from proxy headers or RemoteAddr.
// Forwarding headers (X-Forwarded-For, X-Real-IP) are ONLY trusted if the direct peer
// (RemoteAddr) matches a configured, trusted reverse proxy boundary.
// When traversing X-Forwarded-For, hops are evaluated from right to left (closest proxy to client).
// The first IP encountered that is NOT a trusted proxy is identified as the authentic client IP.
func GetClientIP(r *http.Request) string {
	return GetClientIPWithConfig(r, os.Getenv("TRUSTED_PROXIES"), os.Getenv("TRUST_PROXY"))
}

// GetClientIPWithConfig extracts client IP with explicit proxy configuration parameters.
func GetClientIPWithConfig(r *http.Request, trustedProxiesEnv, trustProxyEnv string) string {
	remoteHost := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		remoteHost = host
	}

	normalizedRemote := NormalizeIP(remoteHost)

	// If the direct peer is not an explicitly trusted proxy, ignore all forwarding headers.
	if !IsTrustedProxyWithConfig(normalizedRemote, trustedProxiesEnv, trustProxyEnv) {
		return normalizedRemote
	}

	// Direct peer IS a trusted proxy: parse X-Forwarded-For right-to-left
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		parts := strings.Split(xff, ",")
		var cleanedIPs []string
		for _, p := range parts {
			trimmed := strings.TrimSpace(p)
			if trimmed != "" {
				cleanedIPs = append(cleanedIPs, NormalizeIP(trimmed))
			}
		}

		if len(cleanedIPs) > 0 {
			// Walk right-to-left (from nearest upstream proxy to client)
			for i := len(cleanedIPs) - 1; i >= 0; i-- {
				candidate := cleanedIPs[i]
				// If candidate is also a trusted proxy, continue stepping left
				if IsTrustedProxyWithConfig(candidate, trustedProxiesEnv, trustProxyEnv) {
					continue
				}
				// First untrusted IP is the verified client IP
				return candidate
			}
			// If all IPs in the chain were trusted proxies, return the leftmost one
			return cleanedIPs[0]
		}
	}

	// Fall back to X-Real-IP if X-Forwarded-For was not provided
	if xrip := r.Header.Get("X-Real-IP"); xrip != "" {
		cleaned := NormalizeIP(strings.TrimSpace(xrip))
		if cleaned != "" {
			return cleaned
		}
	}

	return normalizedRemote
}

// Middleware returns an HTTP handler middleware enforcing the rate limit.
func (rl *RateLimiter) Middleware(rtr *Router) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := GetClientIP(r)
			allowed, retryAfter := rl.Allow(ip)
			if !allowed {
				retrySeconds := int(retryAfter.Seconds())
				if retrySeconds < 1 {
					retrySeconds = 1
				}
				w.Header().Set("Retry-After", fmt.Sprintf("%d", retrySeconds))
				rtr.writeError(w, http.StatusTooManyRequests, "RATE_LIMIT_EXCEEDED", "Too many requests; please retry later")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
