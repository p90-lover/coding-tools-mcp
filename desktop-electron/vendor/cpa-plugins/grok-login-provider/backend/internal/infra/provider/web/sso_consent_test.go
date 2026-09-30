package web

import (
	"encoding/base64"
	"testing"
)

func consentJWT(alg, typ string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"` + alg + `","typ":"` + typ + `"}`))
	return header + ".eyJzdWIiOiJ4In0.c2lnbmF0dXJl"
}

func TestExtractConsentTokenPicksTheES256ConsentJWT(t *testing.T) {
	consent := consentJWT("ES256", "consent+jwt")
	page := []byte(`<script>{"idToken":"` + consentJWT("RS256", "JWT") + `"}</script>` +
		`<input type="hidden" name="consent_token" value="` + consent + `">` +
		`<script>window.__STATE__={&quot;consent&quot;:&quot;` + consent + `&quot;}</script>`)
	if got := extractConsentToken(page); got != consent {
		t.Fatalf("token = %q, want the consent+jwt", got)
	}
}

func TestExtractConsentTokenRejectsMissingOrAmbiguous(t *testing.T) {
	if got := extractConsentToken([]byte(`<p>` + consentJWT("RS256", "JWT") + `</p>`)); got != "" {
		t.Fatalf("non-consent JWT accepted: %q", got)
	}
	first := consentJWT("ES256", "consent+jwt")
	second := base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"consent+jwt","alg":"ES256"}`)) + ".e30.b3RoZXI"
	if got := extractConsentToken([]byte(first + " " + second)); got != "" {
		t.Fatalf("two distinct consent tokens must be refused, got %q", got)
	}
}
