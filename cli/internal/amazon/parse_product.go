package amazon

import (
	"regexp"
	"strings"
)

// ProductDetail holds key fields from an Amazon product detail page (/dp/ASIN).
// Bullets and Specs give the agent raw material to determine comparison units
// (e.g. "200 sheets per roll" in bullets → agent passes qty=200, label="sheet").
type ProductDetail struct {
	ASIN      string            `json:"asin"`
	Title     string            `json:"title"`
	Price     string            `json:"price,omitempty"`
	Bullets   []string          `json:"bullets,omitempty"` // "About this item" bullets
	Specs     map[string]string `json:"specs,omitempty"`   // tech spec table key→value
	ImageURL  string            `json:"image_url,omitempty"`
}

var (
	productTitleRe   = regexp.MustCompile(`(?s)id="productTitle"[^>]*>\s*([^<]+)`)
	productPriceRe   = regexp.MustCompile(`(?s)id="priceblock_ourprice"[^>]*>\s*<[^>]+>\s*([^<]+)`)
	productBulletsRe = regexp.MustCompile(`(?s)id="feature-bullets".*?</ul>`)
	bulletItemRe     = regexp.MustCompile(`(?s)<li>[^<]*<span[^>]*class="[^"]*a-list-item[^"]*"[^>]*>(.*?)</span>`)
	techSpecRowRe    = regexp.MustCompile(`(?s)<tr[^>]*>\s*<th[^>]*>(.*?)</th>\s*<td[^>]*>(.*?)</td>`)
	detailBulletRe   = regexp.MustCompile(`(?s)<span class="a-text-bold">([^<]+)</span>\s*<span>([^<]+)</span>`)
	productImageRe   = regexp.MustCompile(`id="landingImage"[^>]+src="([^"]+)"`)
)

// parseProductHTML extracts ProductDetail from a /dp/ASIN page.
func parseProductHTML(asin, body string) ProductDetail {
	p := ProductDetail{ASIN: asin}

	if m := productTitleRe.FindStringSubmatch(body); m != nil {
		p.Title = html2text(strings.TrimSpace(m[1]))
	}

	// Price: try priceblock_ourprice first, then .a-offscreen inside #corePrice_desktop
	if m := productPriceRe.FindStringSubmatch(body); m != nil {
		p.Price = strings.TrimSpace(html2text(m[1]))
	} else if idx := strings.Index(body, `id="corePrice_desktop"`); idx >= 0 {
		chunk := body[idx : min(idx+2000, len(body))]
		if m := searchPriceRe.FindStringSubmatch(chunk); m != nil {
			p.Price = strings.TrimSpace(m[1])
		}
	}

	// "About this item" bullets
	if sec := productBulletsRe.FindString(body); sec != "" {
		for _, m := range bulletItemRe.FindAllStringSubmatch(sec, -1) {
			text := html2text(strings.TrimSpace(stripTags(m[1])))
			if text != "" && len(text) < 300 {
				p.Bullets = append(p.Bullets, text)
			}
		}
	}

	// Tech spec table (productDetails_techSpec or similar)
	p.Specs = make(map[string]string)
	for _, m := range techSpecRowRe.FindAllStringSubmatch(body, -1) {
		key := html2text(strings.TrimSpace(stripTags(m[1])))
		val := html2text(strings.TrimSpace(stripTags(m[2])))
		if key != "" && val != "" && len(key) < 80 {
			p.Specs[key] = val
		}
	}
	// Detail bullets (e.g. "Package Quantity ‏ : ‎ 24")
	for _, m := range detailBulletRe.FindAllStringSubmatch(body, -1) {
		key := html2text(strings.TrimSpace(m[1]))
		val := html2text(strings.TrimSpace(m[2]))
		if key != "" && val != "" && len(key) < 80 {
			p.Specs[strings.TrimRight(key, " :")] = val
		}
	}

	// Hero image
	if m := productImageRe.FindStringSubmatch(body); m != nil {
		p.ImageURL = m[1]
	}

	return p
}

// stripTags removes HTML tags from a string.
var tagRe = regexp.MustCompile(`<[^>]+>`)

func stripTags(s string) string {
	return tagRe.ReplaceAllString(s, "")
}
