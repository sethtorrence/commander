# Daily Notes are Items, and a Link can point at a Project

A **Daily Note** is itself an Item (kind `daily-note`, one per calendar day), with its Blocks as Items under it. A `[[day]]` link from a Block is then an ordinary **refers to** Link to an Item, and "Mentioned in" on a day's sheet is the same backlinks query every other Item uses. Linking to a day with no Daily Note yet creates the empty Daily Note Item, so every Link has a real target. This extends ADR 0001, which named Blocks but not the Daily Note.

A **Project** is not an Item: Items belong to Projects, and a Project that was also an Item would need a Project of its own. But `[[Project]]` links and the Project page's "Mentioned in" need a Link to reach a Project. So a Link's target is either an Item or a Project, stored in the one Link table with a target-type column, and answered by the one backlinks query. Only **refers to** Links may target a Project; every other Link type still joins two Items.

We chose this over a separate "mentions" table for Projects, which would split backlinks into two queries and two code paths, and over making Projects Items, which would tangle the Project filter and filing with the thing being filed into. The cost is a Link target that is no longer always an Item, which every Link consumer has to handle.
