package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/sophiealula/pp-amazon-skill/cli/internal/amazon"
)

func newSearchCmd() *cobra.Command {
	var limit int
	cmd := &cobra.Command{
		Use:   "search <query>",
		Short: "Search Amazon.com for products (live; not history-limited)",
		Long: `Hits GET /s?k=<query> with session cookies and returns ranked results.

Unlike 'add', this is not limited to purchase history — it surfaces new
products Amazon has never seen you buy. Bot detection risk is higher on this
endpoint than cart/checkout; if Amazon serves a challenge page the command
returns a clear error rather than hanging.

Pipe results into 'add' flows or use --json to inspect ASINs for scripting.`,
		Example: "  amazon-pp-cli search 'paper towels' --profile indyhall-biz --json\n" +
			"  amazon-pp-cli search 'hand soap' --limit 5",
		Args: cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app, err := newAppContext(cmd)
			if err != nil {
				return err
			}
			defer app.Store.Close()
			if err := app.RequireSession(); err != nil {
				return err
			}
			query := joinArgs(args)
			ctx, cancel := contextWithTimeout(app.Ctx, 30*time.Second)
			defer cancel()
			client, err := amazon.New(app.Profile, app.Session)
			if err != nil {
				return err
			}
			results, err := client.SearchProducts(ctx, query)
			if err != nil {
				if errors.Is(err, amazon.ErrRobotCheck) {
					return coded(ExitTransient, "%v", err)
				}
				if errors.Is(err, amazon.ErrAuthExpired) {
					return coded(ExitAuth, "%v", err)
				}
				return coded(ExitTransient, "search: %v", err)
			}
			if limit > 0 && len(results) > limit {
				results = results[:limit]
			}
			if app.JSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(results)
			}
			if len(results) == 0 {
				fmt.Fprintln(cmd.OutOrStderr(), "no results found")
				return nil
			}
			tw := tabwriter.NewWriter(cmd.OutOrStdout(), 0, 0, 2, ' ', 0)
			fmt.Fprintln(tw, "ASIN\tPRIME\tPRICE\tTITLE")
			for _, r := range results {
				prime := " "
				if r.PrimeEligible {
					prime = "✓"
				}
				fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n",
					r.ASIN,
					prime,
					r.Price,
					truncate(r.Title, 60),
				)
			}
			return tw.Flush()
		},
	}
	cmd.Flags().IntVar(&limit, "limit", 10, "Maximum results to return (0 = all)")
	return cmd
}
