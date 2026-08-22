package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/sophiealula/pp-amazon-skill/cli/internal/amazon"
)

func newProductCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "product <asin>",
		Short: "Fetch product detail page fields for a given ASIN",
		Long: `GETs /dp/<asin> and returns title, price, "About this item" bullets,
and tech spec key/value pairs. Useful for determining a meaningful
comparison unit (sheets/roll, fl oz/bottle, etc.) that isn't present
in search results.`,
		Example: "  amazon-pp-cli product B07NXGG55W --json\n" +
			"  amazon-pp-cli product B07NXGG55W --profile indyhall",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			app, err := newAppContext(cmd)
			if err != nil {
				return err
			}
			defer app.Store.Close()
			if err := app.RequireSession(); err != nil {
				return err
			}
			asin := strings.ToUpper(strings.TrimSpace(args[0]))
			if len(asin) < 10 {
				return fmt.Errorf("ASIN must be at least 10 characters, got %q", asin)
			}
			ctx, cancel := contextWithTimeout(app.Ctx, 30*time.Second)
			defer cancel()
			client, err := amazon.New(app.Profile, app.Session)
			if err != nil {
				return err
			}
			detail, err := client.GetProductDetail(ctx, asin)
			if err != nil {
				if errors.Is(err, amazon.ErrRobotCheck) {
					return coded(ExitTransient, "%v", err)
				}
				if errors.Is(err, amazon.ErrAuthExpired) {
					return coded(ExitAuth, "%v", err)
				}
				return coded(ExitTransient, "product: %v", err)
			}
			if app.JSON {
				return json.NewEncoder(cmd.OutOrStdout()).Encode(detail)
			}
			fmt.Fprintf(cmd.OutOrStdout(), "ASIN:  %s\n", detail.ASIN)
			fmt.Fprintf(cmd.OutOrStdout(), "Title: %s\n", detail.Title)
			if detail.Price != "" {
				fmt.Fprintf(cmd.OutOrStdout(), "Price: %s\n", detail.Price)
			}
			if len(detail.Bullets) > 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "\nAbout this item:")
				for _, b := range detail.Bullets {
					fmt.Fprintf(cmd.OutOrStdout(), "  • %s\n", b)
				}
			}
			if len(detail.Specs) > 0 {
				fmt.Fprintln(cmd.OutOrStdout(), "\nSpecs:")
				for k, v := range detail.Specs {
					fmt.Fprintf(cmd.OutOrStdout(), "  %s: %s\n", k, v)
				}
			}
			return nil
		},
	}
	return cmd
}
