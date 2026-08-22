package amazon

import (
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// ParseWarning is emitted when the search parser detects a structural mismatch —
// a field that should be present is missing across all results. Each warning
// carries a self-contained fix instruction so an agent can repair the parser
// without needing to read the raw HTML.
type ParseWarning struct {
	Field   string `json:"field"`
	Symptom string `json:"symptom"`
	Fix     string `json:"fix"`
}

// parseSearchResultsHTML extracts SearchResults from a /s?k= response.
// Amazon has no clean search API; this is best-effort regex, mirroring the
// cart parser's approach. Results are identified by data-component-type=
// "s-search-result" divs; each carries a data-asin attribute.
func parseSearchResultsHTML(body string) ([]SearchResult, []ParseWarning) {
	asinMatches := searchAsinRe.FindAllStringIndex(body, -1)
	if len(asinMatches) == 0 {
		return nil, diagnoseSearchResults(body, nil)
	}
	var results []SearchResult
	seen := make(map[string]bool)
	for _, pos := range asinMatches {
		// Confirm this data-asin lives on a search-result div by checking
		// ±600 bytes for the component-type marker (they share an opening tag).
		lo := pos[0] - 600
		if lo < 0 {
			lo = 0
		}
		hi := pos[1] + 600
		if hi > len(body) {
			hi = len(body)
		}
		if !strings.Contains(body[lo:hi], `data-component-type="s-search-result"`) {
			continue
		}
		asinMatch := searchAsinRe.FindStringSubmatch(body[pos[0]:pos[1]+1])
		if asinMatch == nil {
			continue
		}
		asin := asinMatch[1]
		if seen[asin] {
			continue
		}
		seen[asin] = true
		// Grab a chunk starting at the ASIN position; 15 KB covers price + Prime badge.
		end := pos[0] + 15000
		if end > len(body) {
			end = len(body)
		}
		chunk := body[pos[0]:end]
		title := extractSearchTitle(chunk)
		if title == "" {
			continue
		}
		results = append(results, SearchResult{
			ASIN:             asin,
			Title:            title,
			Price:            extractSearchPrice(chunk),
			UnitPrice:        extractSearchUnitPrice(chunk),
			Stars:            extractSearchStars(chunk),
			ReviewCount:      extractSearchReviewCount(chunk),
			PrimeEligible:    strings.Contains(chunk, "a-icon-prime") || strings.Contains(chunk, `aria-label="Amazon Prime"`),
			Coupon:           extractSearchCoupon(chunk),
			DeliveryDate:     extractSearchDelivery(chunk),
			Badge:            extractSearchBadge(chunk),
			Sponsored:        strings.Contains(body[lo:hi], `data-component-type="sp-sponsored-result"`),
			SubscribeAndSave: strings.Contains(chunk, "Subscribe & Save"),
			URL:              extractSearchURL(chunk),
			ImageURL:         extractSearchImage(chunk),
		})
	}
	return results, diagnoseSearchResults(body, results)
}

// diagnoseSearchResults inspects parse output for structural mismatches and
// returns self-contained repair instructions an agent can act on directly.
func diagnoseSearchResults(body string, results []SearchResult) []ParseWarning {
	var warnings []ParseWarning
	if len(results) == 0 {
		lower := strings.ToLower(body[:min(4096, len(body))])
		switch {
		case strings.Contains(body, `data-component-type="s-search-result"`):
			warnings = append(warnings, ParseWarning{
				Field:   "results",
				Symptom: "page contains s-search-result elements but zero results parsed",
				Fix:     `searchAsinRe in parse.go matches \bdata-asin="([A-Z0-9]{10,})". Verify data-asin still appears within 600 bytes of data-component-type="s-search-result" on the same div. If Amazon renamed the attribute or component type, update both constants.`,
			})
		case strings.Contains(lower, "type the characters") || strings.Contains(lower, "enter the characters") || strings.Contains(lower, "sorry, we just need to make sure"):
			warnings = append(warnings, ParseWarning{
				Field:   "results",
				Symptom: "Amazon served a CAPTCHA page — bot detection triggered",
				Fix:     "Open amazon.com in your browser, solve the CAPTCHA, then retry. Do not retry automatically.",
			})
		case len(body) < 5000:
			warnings = append(warnings, ParseWarning{
				Field:   "results",
				Symptom: fmt.Sprintf("response body unexpectedly short (%d bytes) — likely a redirect or error page", len(body)),
				Fix:     "Run doctor to verify session health. Re-paste cookies if expired.",
			})
		default:
			warnings = append(warnings, ParseWarning{
				Field:   "results",
				Symptom: "Amazon returned a page with no recognizable search result elements",
				Fix:     "Amazon may be serving a category landing page, editorial page, or unrecognized bot-detection variant for this query. Try a more specific query (e.g. 'coffee pods k-cup' instead of 'coffee'). If the issue persists across queries, check session health with doctor.",
			})
		}
		return warnings
	}
	emptyPrice := 0
	for _, r := range results {
		if r.Price == "" {
			emptyPrice++
		}
	}
	if emptyPrice == len(results) {
		warnings = append(warnings, ParseWarning{
			Field:   "price",
			Symptom: "all results have empty price",
			Fix:     `searchPriceRe in parse.go matches <span class="a-offscreen">. Verify this class exists within 15000 chars of each data-asin marker. If Amazon moved the price further or changed the class name, update the chunk size constant (15000) or the regex in parse.go.`,
		})
	}
	emptyStars := 0
	for _, r := range results {
		if r.Stars == 0 {
			emptyStars++
		}
	}
	if emptyStars == len(results) {
		warnings = append(warnings, ParseWarning{
			Field:   "stars",
			Symptom: "all results have zero stars",
			Fix:     `parse.go tries three star patterns in order: aria-label="X.X out of 5 stars", ">X.X out of 5 stars<" span text, and a-star-mini-N-N CSS class. If all fail, Amazon likely moved the rating outside the 15000-char chunk from the ASIN marker. Dump raw HTML and measure the distance from data-asin to the first star signal, then update the chunk size constant in parseSearchResultsHTML.`,
		})
	}
	return warnings
}

var (
	searchAsinRe      = regexp.MustCompile(`\bdata-asin="([A-Z0-9]{10,})"`)
	searchH2Re        = regexp.MustCompile(`(?s)<h2\b[^>]*>(.*?)</h2>`)
	searchSpanRe      = regexp.MustCompile(`<span[^>]*>([^<]{5,})</span>`)
	searchPriceRe     = regexp.MustCompile(`<span[^>]+class="[^"]*a-offscreen[^"]*"[^>]*>([^<]+)</span>`)
	searchStarsAriaRe = regexp.MustCompile(`aria-label="([\d.]+) out of 5 stars"`)
	searchStarsTextRe = regexp.MustCompile(`>([\d.]+) out of 5 stars<`)
	searchStarsMiniRe = regexp.MustCompile(`a-star-mini-(\d+)(?:-(\d+))?`)
	searchReviewsRe   = regexp.MustCompile(`aria-label="([\d,]+) ratings"`)
	searchUnitPriceRe = regexp.MustCompile(`\(\$([\d.]+)(?:</[^>]+>)?\s*/\s*([\w\s\d/]+?)\)`)
	searchCouponRe    = regexp.MustCompile(`(?i)Save\s+([\d]+%|\$[\d.]+)`)
	searchDeliveryRe  = regexp.MustCompile(`(?i)(?:Get it|FREE delivery)[^<]{0,80}?([A-Z][a-z]{2},\s+[A-Z][a-z]{2}\s+\d+)`)
	searchBadgeRe     = regexp.MustCompile(`(?i)<span[^>]+class="[^"]*a-badge-label[^"]*"[^>]*>([^<]+)<`)
	searchURLRe       = regexp.MustCompile(`href="(/[^"]+/dp/[A-Z0-9]{10}[^"]*?)"`)
	searchImageRe     = regexp.MustCompile(`<img[^>]+class="[^"]*s-image[^"]*"[^>]+src="([^"]+)"`)
)

func extractSearchTitle(chunk string) string {
	h2 := searchH2Re.FindStringSubmatch(chunk)
	if h2 == nil {
		return ""
	}
	sp := searchSpanRe.FindStringSubmatch(h2[1])
	if sp == nil {
		return ""
	}
	return html2text(strings.TrimSpace(sp[1]))
}

func extractSearchPrice(chunk string) string {
	m := searchPriceRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func extractSearchStars(chunk string) float64 {
	// Try precise decimal from aria-label on icon element.
	if m := searchStarsAriaRe.FindStringSubmatch(chunk); m != nil {
		if f, err := strconv.ParseFloat(m[1], 64); err == nil {
			return f
		}
	}
	// Try span text content ("4.3 out of 5 stars").
	if m := searchStarsTextRe.FindStringSubmatch(chunk); m != nil {
		if f, err := strconv.ParseFloat(m[1], 64); err == nil {
			return f
		}
	}
	// Fall back to CSS class (rounds to nearest 0.5).
	if m := searchStarsMiniRe.FindStringSubmatch(chunk); m != nil {
		whole, _ := strconv.Atoi(m[1])
		if m[2] != "" {
			frac, _ := strconv.Atoi(m[2])
			return float64(whole) + float64(frac)/10.0
		}
		return float64(whole)
	}
	return 0
}

func extractSearchReviewCount(chunk string) int {
	m := searchReviewsRe.FindStringSubmatch(chunk)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(strings.ReplaceAll(m[1], ",", ""))
	return n
}

func extractSearchUnitPrice(chunk string) string {
	m := searchUnitPriceRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	return "$" + m[1] + " / " + strings.TrimSpace(m[2])
}

func extractSearchCoupon(chunk string) string {
	m := searchCouponRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	return "Save " + m[1]
}

func extractSearchDelivery(chunk string) string {
	m := searchDeliveryRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	return strings.TrimSpace(m[1])
}

func extractSearchBadge(chunk string) string {
	m := searchBadgeRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	return html2text(strings.TrimSpace(m[1]))
}

func extractSearchURL(chunk string) string {
	m := searchURLRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	parts := strings.Split(m[1], "/dp/")
	if len(parts) < 2 {
		return m[1]
	}
	asin := strings.Split(parts[1], "/")[0]
	return "/dp/" + asin
}

func extractSearchImage(chunk string) string {
	m := searchImageRe.FindStringSubmatch(chunk)
	if m == nil {
		return ""
	}
	return m[1]
}

// parseCartHTML extracts CartLines from a /gp/cart/view.html response.
//
// Amazon's cart page is HTML-only; we read the per-line data attributes:
//
//	<div data-asin="B0FOO" data-quantity="2" data-item-name="..." ...>
//
// When data-attributes aren't present (account display variant), we fall back
// to a "data-item-asin" + "data-quantity" pair. Best-effort; the canonical
// confirmation that an add succeeded is the cart's row count delta.
func parseCartHTML(body string) []CartLine {
	var lines []CartLine
	for _, re := range []*regexp.Regexp{cartLineRe1, cartLineRe2} {
		matches := re.FindAllStringSubmatch(body, -1)
		for _, m := range matches {
			asin := m[1]
			if asin == "" {
				continue
			}
			line := CartLine{ASIN: asin, Quantity: 1}
			if len(m) > 2 && m[2] != "" {
				if q, err := strconv.Atoi(m[2]); err == nil && q > 0 {
					line.Quantity = q
				}
			}
			if len(m) > 3 && m[3] != "" {
				line.Title = html2text(m[3])
			}
			lines = append(lines, line)
		}
		if len(lines) > 0 {
			break
		}
	}
	return dedupeCartLines(lines)
}

var (
	cartLineRe1 = regexp.MustCompile(`(?s)data-asin="([A-Z0-9]{10})"[^>]*data-quantity="(\d+)"[^>]*data-item-name="([^"]+)"`)
	cartLineRe2 = regexp.MustCompile(`(?s)data-item-asin="([A-Z0-9]{10})"[^>]*data-item-quantity="(\d+)"[^>]*data-item-title="([^"]+)"`)
)

func dedupeCartLines(in []CartLine) []CartLine {
	seen := make(map[string]int, len(in))
	var out []CartLine
	for _, line := range in {
		if idx, ok := seen[line.ASIN]; ok {
			out[idx].Quantity += line.Quantity
			if out[idx].Title == "" {
				out[idx].Title = line.Title
			}
			continue
		}
		seen[line.ASIN] = len(out)
		out = append(out, line)
	}
	return out
}

// extractAccountName scrapes the "Hello, <name>" greeting from the homepage.
// Returns empty string if not found (treat as "logged out" at the caller).
var accountGreetingRe = regexp.MustCompile(`(?i)<span[^>]*id="nav-link-accountList-nav-line-1"[^>]*>([^<]+)<`)

func extractAccountName(body string) string {
	m := accountGreetingRe.FindStringSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return strings.TrimSpace(html2text(m[1]))
}

// parseSPCTokens extracts the hidden form tokens from the SPC checkout page.
// These tokens (purchase_id, anti-csrf, anti-csrftoken-a2z, etc.) are required
// to round-trip the place-your-order POST.
//
// Returns an error when the page doesn't look like the SPC page (the user
// probably has an empty cart or Amazon redirected to the cart view).
func parseSPCTokens(body string) (map[string]string, error) {
	if !strings.Contains(body, "spc-place-order-button") && !strings.Contains(body, "placeYourOrder") {
		return nil, errors.New("checkout page did not contain the place-order form; the cart may be empty or your account needs attention on amazon.com")
	}
	tokens := make(map[string]string)
	for _, tag := range inputTagRe.FindAllString(body, -1) {
		if !typeHiddenRe.MatchString(tag) {
			continue
		}
		nm := nameAttrRe.FindStringSubmatch(tag)
		if nm == nil || !isInterestingToken(nm[1]) {
			continue
		}
		val := ""
		if vm := valueAttrRe.FindStringSubmatch(tag); vm != nil {
			val = vm[1]
		}
		tokens[nm[1]] = html2text(val)
	}
	return tokens, nil
}

// Hidden inputs are matched per-tag with separate attribute regexes so the
// attribute order Amazon renders (type/name/value vs name/type/value) doesn't
// matter.
var (
	inputTagRe   = regexp.MustCompile(`(?i)<input\b[^>]*>`)
	typeHiddenRe = regexp.MustCompile(`(?i)\btype\s*=\s*"hidden"`)
	nameAttrRe   = regexp.MustCompile(`(?i)\bname\s*=\s*"([^"]+)"`)
	valueAttrRe  = regexp.MustCompile(`(?i)\bvalue\s*=\s*"([^"]*)"`)
)

func isInterestingToken(name string) bool {
	switch name {
	case "purchase_id", "purchaseId", "pipelineType", "anti-csrftoken-a2z", "ue_back",
		"clientIp", "ref_", "fwcim_session_id", "shippingOption", "session-id":
		return true
	}
	return strings.HasPrefix(name, "purchase") ||
		strings.HasPrefix(name, "merchantId") ||
		strings.HasPrefix(name, "ie")
}

var thankYouOrderRe = regexp.MustCompile(`(?i)order(?:\s*#|\s+number[:\s]+)\s*([0-9]{3}-[0-9]{7}-[0-9]{7})`)

func extractThankYouOrderID(body string) string {
	m := thankYouOrderRe.FindStringSubmatch(body)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// html2text is a tiny HTML entity decoder for the fields we extract. Good
// enough for &amp; &#39; &quot; &lt; &gt;.
func html2text(s string) string {
	s = strings.ReplaceAll(s, "&amp;", "&")
	s = strings.ReplaceAll(s, "&#39;", "'")
	s = strings.ReplaceAll(s, "&apos;", "'")
	s = strings.ReplaceAll(s, "&quot;", `"`)
	s = strings.ReplaceAll(s, "&lt;", "<")
	s = strings.ReplaceAll(s, "&gt;", ">")
	s = strings.ReplaceAll(s, "&nbsp;", " ")
	return s
}
