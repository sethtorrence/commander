# PROTOTYPE content: Projects (adds to CONTENT.md)

The author works on several **Projects** at once. Every item in Commander (email, Linear issue, PR, calendar event, Todo, Daily Note block) belongs to **at most one** Project, or is **Unfiled**. A Project is shown by its **Badge**: a two-letter code stamped on the Project's accent colour, like a part-number stamp. Badges only, no emoji or glyph icons.

## Projects and Badges

| Badge | Project | Dark accent | Light accent | Badge text |
|---|---|---|---|---|
| `LT` | Longtail | `#3D7BFF` | `#3D7BFF` | `#141414` |
| `TL` | Titanlink | `#00BFA5` | `#009581` | `#141414` |
| `TX` | Tactics | `#A970FF` | `#9D68ED` | `#141414` |
| `—` | Unfiled | outline only, in the faint ink colour | same | faint ink |

Colour rule: Project accents appear ONLY as the Badge itself and, optionally, a thin left-edge bar on an item row. Never as fills, buttons, headings or large areas. International orange keeps its job (live things and Titanus) and is never a Project colour.

## How items get their Project (all three, shown in the UI)
1. **Rules** the User sets once per Source (show a "mapped by rule" hint on hover or in detail views), e.g.:
   - Linear team ENG → Titanlink; Linear team LT → Longtail; Linear team TAC → Tactics
   - GitHub northwind/api, northwind/infra → Titanlink; longtail/app → Longtail
   - Email from @acmepayments.com → Titanlink; from @longtail.so → Longtail
   - Calendar events with "Board" → Tactics
2. **Titanus suggests** a Project for anything rules miss: a dashed Badge with "Titanus thinks: LT" and Confirm / Change. In his voice, plain.
3. **Manual**: clicking any Badge opens a small picker to change the Project.

## Assignments for the sample data
- **Titanlink (TL)**: ENG-412, ENG-418, ENG-421, ENG-399; northwind/api #2213, #2198, northwind/infra #340; 1:1 with Priya; Vendor call: Acme Payments; "Contract redlines, v3" email; Todos "Decide on the Acme Payments contract", "Give Priya Acme sandbox access"; the Daily Note's 1:1 notes.
- **Longtail (LT)**: northwind/web #981 "Billing settings redesign" is NOT Longtail (keep TL). Add these Longtail items:
  - Email · Jo Alvarez · "Longtail beta: onboarding feedback" · personal Gmail · 3h ago · Needs reply
  - Linear LT-88 "Onboarding checklist copy" · Todo (Longtail workspace)
  - GitHub longtail/app #57 "Magic-link sign-in" · review requested
  - Tomorrow 15:00 Interview: Staff engineer → Longtail
- **Tactics (TX)**: "Q4 offsite: which dates work?" (Dana) email and its suggested Todo; Tomorrow 10:00 Board prep with Marcus; Linear TAC-14 "Draft Q4 positioning" · In Progress; Daily Note idea "The Daily Note should be where I think" stays Unfiled.
- **Unfiled**: Mum "Sunday lunch?", "Buy a birthday gift for Sam", Newsletters/Receipts, the Daily Note Morning block, Eng standup.
- **Titanus suggestion example**: an Unfiled email from "Sam Okafor · Re: intro to the Tactics advisors" → "Titanus thinks: TX. The subject says Tactics and Sam wrote about it last week." Confirm / Change.

## Where Projects show
- A **Project filter bar** at the top of the Dashboard and every Section: Everything · LT Longtail · TL Titanlink · TX Tactics · Unfiled, with counts. Filtering really filters.
- **Badges on every item** row, compact.
- A **Project page** for each Project (click a Project in the filter bar with a modifier or a "page" affordance, or click a Badge → "Open Longtail"): a mini-Dashboard of just that Project across all Sections (its schedule, Todos, emails, Linear, GitHub, Daily Note mentions), plus its mapping rules listed.
