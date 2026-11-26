# Vineyard School Events

A standalone school events calendar for [ItemSwap Events](https://itemswap.co.uk/events).

The page and event data are in `public/index.html`. Cloudflare Workers Builds deploys the calendar from `main` using `wrangler deploy`. The Wrangler routes are scoped to `/events` and `/events/*`. The marketplace uses a separate Worker.

To run the Worker locally, use `npx wrangler dev` and open `/events` on the displayed local address. The HTML file can also be opened directly in a browser.
