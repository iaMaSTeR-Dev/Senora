package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Task 2: Required Test 1 — Direct requests cannot spoof their client IP through forwarded headers.
func TestProxyAudit_DirectRequestsCannotSpoof(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	req.RemoteAddr = "203.0.113.195:54321"
	req.Header.Set("X-Forwarded-For", "198.51.100.1")
	req.Header.Set("X-Real-IP", "198.51.100.2")

	// Even if TRUST_PROXY=true is set, direct external IP is NOT loopback and NOT in trusted CIDRs
	clientIP := GetClientIPWithConfig(req, "", "true")
	if clientIP != "203.0.113.195" {
		t.Fatalf("SECURITY VIOLATION: Direct external client spoofed IP! Expected '203.0.113.195', got %q", clientIP)
	}
}

// Task 2: Required Test 2 — Requests from untrusted private-network addresses cannot spoof forwarded IPs.
func TestProxyAudit_UntrustedPrivateNetworkCannotSpoof(t *testing.T) {
	privateIPs := []string{
		"192.168.1.100:4321",
		"10.0.5.23:9999",
		"172.16.50.1:1234",
	}

	for _, remote := range privateIPs {
		req := httptest.NewRequest("GET", "/api/v1/health", nil)
		req.RemoteAddr = remote
		req.Header.Set("X-Forwarded-For", "1.1.1.1")
		req.Header.Set("X-Real-IP", "2.2.2.2")

		// TRUST_PROXY=true alone must NOT trust arbitrary private network addresses (only loopback)
		clientIP := GetClientIPWithConfig(req, "", "true")
		expected := NormalizeIP(remote)
		if clientIP != expected {
			t.Fatalf("SECURITY VIOLATION: Untrusted private network %s spoofed IP! Expected %q, got %q", remote, expected, clientIP)
		}
	}
}

// Task 2: Required Test 3 — A configured trusted reverse proxy can forward the expected client IP.
func TestProxyAudit_ConfiguredTrustedProxyForwardsClientIP(t *testing.T) {
	// Case A: Default loopback trusted when TRUST_PROXY=true
	reqA := httptest.NewRequest("GET", "/api/v1/health", nil)
	reqA.RemoteAddr = "127.0.0.1:39201"
	reqA.Header.Set("X-Forwarded-For", "203.0.113.88")
	if ip := GetClientIPWithConfig(reqA, "", "true"); ip != "203.0.113.88" {
		t.Fatalf("Expected client IP 203.0.113.88 forwarded from loopback, got %q", ip)
	}

	// Case B: Explicit TRUSTED_PROXIES CIDR (e.g. Docker bridge or specific proxy cluster)
	reqB := httptest.NewRequest("GET", "/api/v1/health", nil)
	reqB.RemoteAddr = "172.20.0.2:8080"
	reqB.Header.Set("X-Forwarded-For", "198.51.100.42")
	if ip := GetClientIPWithConfig(reqB, "172.20.0.0/16, 10.0.0.1", ""); ip != "198.51.100.42" {
		t.Fatalf("Expected client IP 198.51.100.42 forwarded from trusted CIDR, got %q", ip)
	}
}

// Task 2: Required Test 4 — Multiple forwarded IP values are parsed according to a documented, safe trust-chain policy.
func TestProxyAudit_MultipleForwardedIPTrustChain(t *testing.T) {
	// Deployment: Public Client (203.0.113.77) -> CDN/Proxy 1 (10.0.1.5) -> Ingress (127.0.0.1) -> NexaChat
	// Attacker tries to inject spoofed header "8.8.8.8" into their request before hitting CDN
	// Resulting X-Forwarded-For received at Ingress: "8.8.8.8, 203.0.113.77, 10.0.1.5"
	trustedProxies := "127.0.0.1, 10.0.0.0/16"

	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	req.Header.Set("X-Forwarded-For", "8.8.8.8, 203.0.113.77, 10.0.1.5")

	// Walk right-to-left:
	// - 127.0.0.1 is trusted direct peer
	// - 10.0.1.5 is in 10.0.0.0/16, so it is a trusted intermediate proxy
	// - 203.0.113.77 is untrusted -> FIRST untrusted IP encountered is the authentic client!
	// - 8.8.8.8 is untrusted spoof injected by client -> must be ignored!
	clientIP := GetClientIPWithConfig(req, trustedProxies, "")
	if clientIP != "203.0.113.77" {
		t.Fatalf("SECURITY VIOLATION: Trust chain traversal failed! Expected verified client '203.0.113.77', got %q", clientIP)
	}
}

// Task 2: Required Test 5 — Malformed and IPv4-mapped IPv6 addresses are handled consistently.
func TestProxyAudit_MalformedAndIPv4MappedIPv6(t *testing.T) {
	// Subcase A: IPv4-mapped IPv6 address normalized
	reqA := httptest.NewRequest("GET", "/api/v1/health", nil)
	reqA.RemoteAddr = "127.0.0.1:8080"
	reqA.Header.Set("X-Forwarded-For", "::ffff:203.0.113.195")
	if ip := GetClientIPWithConfig(reqA, "", "true"); ip != "203.0.113.195" {
		t.Fatalf("Expected IPv4-mapped IPv6 to normalize to 203.0.113.195, got %q", ip)
	}

	// Subcase B: Bracketed IPv4-mapped IPv6
	reqB := httptest.NewRequest("GET", "/api/v1/health", nil)
	reqB.RemoteAddr = "[::1]:8080"
	reqB.Header.Set("X-Forwarded-For", "[::ffff:198.51.100.77]:9090")
	if ip := GetClientIPWithConfig(reqB, "", "true"); ip != "198.51.100.77" {
		t.Fatalf("Expected bracketed IPv4-mapped IPv6 to normalize to 198.51.100.77, got %q", ip)
	}

	// Subcase C: Malformed header tokens do not cause crash or bypass
	reqC := httptest.NewRequest("GET", "/api/v1/health", nil)
	reqC.RemoteAddr = "127.0.0.1:8080"
	reqC.Header.Set("X-Forwarded-For", "not-a-valid-ip, 203.0.113.5")
	if ip := GetClientIPWithConfig(reqC, "", "true"); ip != "203.0.113.5" {
		t.Fatalf("Expected right-to-left traversal to return valid IP 203.0.113.5, got %q", ip)
	}
}

// Task 2: Required Test 6 — Disabling proxy trust ignores forwarded headers.
func TestProxyAudit_DisablingProxyTrustIgnoresHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/v1/health", nil)
	req.RemoteAddr = "127.0.0.1:8080"
	req.Header.Set("X-Forwarded-For", "203.0.113.99")
	req.Header.Set("X-Real-IP", "203.0.113.100")

	// TRUST_PROXY=false and TRUSTED_PROXIES=""
	clientIP := GetClientIPWithConfig(req, "", "false")
	if clientIP != "127.0.0.1" {
		t.Fatalf("Expected RemoteAddr 127.0.0.1 when proxy trust is disabled, got %q", clientIP)
	}

	clientIPDefault := GetClientIPWithConfig(req, "", "")
	if clientIPDefault != "127.0.0.1" {
		t.Fatalf("Expected RemoteAddr 127.0.0.1 when proxy trust is unset (default), got %q", clientIPDefault)
	}
}

// Task 2: Required Test 7 — Rate limiting cannot be trivially bypassed by rotating forged forwarded IP values.
func TestProxyAudit_RateLimiterCannotBeBypassedByRotatingHeaders(t *testing.T) {
	server, router, _, _ := setupSecurityTestServer(t)
	router.GetAuthLimiter().Reset()
	client := server.Client()

	payload, _ := json.Marshal(map[string]string{
		"username": "attacker",
		"password": "wrong_password",
	})

	// Client sends 10 requests rotating fake X-Forwarded-For headers.
	// Since TRUST_PROXY is not enabled on this test server, headers are ignored.
	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("198.51.100.%d", i+1))
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("Request %d failed: %v", i, err)
		}
		resp.Body.Close()
	}

	// 11th request with a new spoofed IP must be rate-limited (HTTP 429)
	req, _ := http.NewRequest("POST", server.URL+"/api/v1/auth/login", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", "198.51.100.254")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("11th request failed: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("SECURITY FLAW: Rate limiter bypassed via rotated X-Forwarded-For! Expected HTTP 429, got: %d", resp.StatusCode)
	}
}
