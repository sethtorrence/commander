# PROTOTYPE verdict: Dashboard and Section layout

Answers [Dashboard and Section layout](https://github.com/sethtorrence/commander/issues/10) on the Commander wayfinder map. Everything here is throwaway; the decision lives on the ticket.

- Three Dashboards were built in the locked look (Industrial, international orange, light and dark): PANEL (control panel), FEED (one ranked feed), HUB (Daily Note as hub). The author picked **FEED**.
- The author asked for **Projects** (Longtail, Titanlink, Tactics) marked by Badges. They were added to FEED only (`variants/feed.html`); PANEL and HUB are round-one references without Projects.
- Section pattern: every Section has the Project filter; only Email adds an Account switcher.

Reference implementation: `variants/feed.html` (deep links like `#project/lt`, `#email`).
