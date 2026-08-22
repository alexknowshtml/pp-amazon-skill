package cli

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"
)

type cartAddAsinResult struct {
	ASIN          string `json:"asin"`
	Added         bool   `json:"added"`
	Quantity      int    `json:"quantity"`
	Title         string `json:"title,omitempty"`
	Reason        string `json:"reason,omitempty"`
	DryRun        bool   `json:"dry_run"`
	ConfirmPhrase string `json:"confirm_phrase,omitempty"`
}

func newCartAddAsinCmd() *cobra.Command {
	var qty int
	var confirmPhrase string
	cmd := &cobra.Command{
		Use:   "add-asin <ASIN>",
		Short: "Add any item to cart by ASIN (bypasses order-history requirement)",
		Long: strings.TrimSpace(`
Adds an item directly by ASIN without requiring it to be in your purchase
history. Use this for discovery purchases — new items you haven't ordered
before.

--confirm-phrase is required for all non-dry-run adds. Pass the exact phrase
the user typed to confirm the purchase. This prevents the agent from adding
items without explicit human confirmation.`),
		Example: "  amazon-pp-cli --profile personal cart add-asin B08N5WRWNW --confirm-phrase 'JFDI'\n" +
			"  amazon-pp-cli --profile indyhall-biz cart add-asin B07XJ8C8F5 --quantity 2 --confirm-phrase 'JFDI'\n" +
			"  amazon-pp-cli --profile personal cart add-asin B08N5WRWNW --dry-run",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app, err := newAppContext(cmd)
			if err != nil {
				return err
			}
			defer app.Store.Close()

			asin := strings.ToUpper(strings.TrimSpace(args[0]))
			if asin == "" {
				return coded(ExitUsage, "ASIN cannot be empty")
			}
			if qty <= 0 {
				return coded(ExitUsage, "--quantity must be >= 1 (got %d)", qty)
			}

			res := cartAddAsinResult{
				ASIN:     asin,
				Quantity: qty,
				DryRun:   app.DryRun,
			}

			if !app.DryRun {
				if strings.TrimSpace(confirmPhrase) == "" {
					res.Reason = "cart mutations require --confirm-phrase; pass the exact phrase the user typed to confirm"
					if app.JSON {
						return json.NewEncoder(cmd.OutOrStdout()).Encode(res)
					}
					return coded(ExitUsage, "%s", res.Reason)
				}
				res.ConfirmPhrase = confirmPhrase
			}

			if err := app.RequireSession(); err != nil {
				return err
			}

			if app.DryRun {
				if app.JSON {
					return json.NewEncoder(cmd.OutOrStdout()).Encode(res)
				}
				fmt.Fprintf(cmd.OutOrStdout(), "would add %s × %d to cart\n", asin, qty)
				return nil
			}

			ctx, cancel := contextWithTimeout(app.Ctx, 120*time.Second)
			defer cancel()

			br, herr := runBrowserHelperAdd(ctx, app.Cfg.CookiesPath(app.Profile.Name), asin, qty)
			if herr != nil {
				if app.JSON && br != nil {
					res.Added = false
					res.Reason = br.Reason
					_ = json.NewEncoder(cmd.OutOrStdout()).Encode(res)
				}
				return herr
			}
			if br.Status == "add_failed" {
				res.Added = false
				res.Reason = br.Reason
				if app.JSON {
					return json.NewEncoder(cmd.OutOrStdout()).Encode(res)
				}
				return coded(ExitTransient, "add failed: %s", br.Reason)
			}

			res.Added = true
			if br.Title != "" {
				res.Title = br.Title
			}
			if br.Quantity > 0 {
				res.Quantity = br.Quantity
			}

			if app.JSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(res)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "added %s × %d (%s)\n", asin, res.Quantity, truncate(res.Title, 60))
			return nil
		},
	}
	cmd.Flags().IntVar(&qty, "quantity", 1, "Number of units to add (default 1)")
	cmd.Flags().StringVar(&confirmPhrase, "confirm-phrase", "", "Exact phrase the user typed to confirm the add (required for non-dry-run)")
	return cmd
}
