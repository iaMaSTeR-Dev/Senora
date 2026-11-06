package api

import (
	"crypto/sha256"
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

// ---------------------------------------------------------------------
// Auto-Ban Spam & Brute-Force Tracker
// ---------------------------------------------------------------------

type AutoBanTracker struct {
	mu        sync.Mutex
	failures  map[string][]time.Time
	threshold int
	window    time.Duration
	enabled   bool
}

func NewAutoBanTracker(threshold int, window time.Duration) *AutoBanTracker {
	if threshold <= 0 {
		threshold = 5
	}
	if window <= 0 {
		window = 1 * time.Minute
	}
	return &AutoBanTracker{
		failures:  make(map[string][]time.Time),
		threshold: threshold,
		window:    window,
		enabled:   true,
	}
}

func (a *AutoBanTracker) SetEnabled(enabled bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.enabled = enabled
}

func (a *AutoBanTracker) IsEnabled() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.enabled
}

func (a *AutoBanTracker) SetThreshold(t int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if t > 0 {
		a.threshold = t
	}
}

func (a *AutoBanTracker) GetThreshold() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.threshold
}

// RecordFailure tracks a failure for rawIP. Returns true if threshold is breached (auto-ban triggered).
// Loopback IP addresses (127.0.0.1, ::1) are strictly exempt to avoid locking out developer environments.
func (a *AutoBanTracker) RecordFailure(rawIP string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	if !a.enabled {
		return false
	}

	normIP := NormalizeIP(rawIP)
	parsed := net.ParseIP(normIP)
	if parsed != nil && parsed.IsLoopback() {
		return false
	}

	now := time.Now()
	cutoff := now.Add(-a.window)

	var valid []time.Time
	for _, t := range a.failures[normIP] {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	valid = append(valid, now)
	a.failures[normIP] = valid

	if len(valid) >= a.threshold {
		// Reset tracking after threshold breach
		delete(a.failures, normIP)
		return true
	}
	return false
}

func (a *AutoBanTracker) ResetIP(rawIP string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	delete(a.failures, NormalizeIP(rawIP))
}

// ---------------------------------------------------------------------
// IP Classification & Device Fingerprinting
// ---------------------------------------------------------------------

// ClassifyIP analyzes an IP address and returns a human-friendly Persian classification and an icon.
func ClassifyIP(rawIP string) (label string, emoji string) {
	norm := NormalizeIP(rawIP)
	parsed := net.ParseIP(norm)
	if parsed == nil {
		return "آدرس نامعتبر", "❓"
	}

	if parsed.IsLoopback() {
		return "لوکال و لوپ‌بک سرور (Localhost / Loopback)", "💻"
	}

	if parsed.IsPrivate() {
		return "شبکه محلی یا VPN خصوصی (Private LAN / VPN)", "🔒"
	}

	if parsed.IsLinkLocalUnicast() || parsed.IsLinkLocalMulticast() {
		return "شبکه محلی پیوندی (Link-Local)", "🔗"
	}

	return "اینترنت عمومی (Public WAN / Internet)", "🌍"
}

// GenerateDeviceFingerprint generates a persistent 12-char SHA-256 hash representing the client's browser/device profile.
func GenerateDeviceFingerprint(r *http.Request, clientIP string) string {
	ua := r.Header.Get("User-Agent")
	lang := r.Header.Get("Accept-Language")
	secCH := r.Header.Get("Sec-CH-UA")

	raw := fmt.Sprintf("%s|%s|%s|%s", NormalizeIP(clientIP), ua, lang, secCH)
	hash := sha256.Sum256([]byte(raw))
	return fmt.Sprintf("fp_%x", hash[:6])
}

