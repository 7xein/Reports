# Which work counts as warranty — decided 12 November 2026

The CEO report's "money at risk" excludes warranty work, because EVS will never
bill a customer for it. How a job is recognised as warranty was, until now, a
single regular expression: any tag whose name contains "warrant".

That was wrong in two ways, both found by reading the live tag tables.

## Why the regex had to go

**It matched the negations.** Six tags contain the word "warranty" and mean the
exact opposite of warranty:

`NO WARRANTY` · `NON WARRANTY` · `No Warranty Book` · `SERVICE NON WARRANTY` ·
`12V BATTERY NON WARRANTY` · `SERVIC NON WARRANTY`

**808** non-historical job cards carry one of these in `tag_ids` and **169** in
`x_studio_stages_tags`. Every one is explicitly billable work that was being
dropped from the money-at-risk figure as though it were free. The figure was
understated by whatever those jobs are worth.

**And it swept in the administrative tags.** Of 34,437 non-historical job cards,
**12,526 — 36%** — carried a tag the regex read as warranty. Many of those tags
describe paperwork about a warranty rather than repair work done under one:
activating a warranty, extending one, changing an owner's name, chasing a late
payment. Those jobs get billed.

A pattern match cannot tell these apart, and the next tag somebody invents —
`WARRANTY DECLINED` — would break it again. So the list is now explicit and
configurable in Admin, the way `presenceTags` and `insuranceTags` already are.
The regex survives only as a fallback for a fresh install, and with the
negations excluded.

## The warranty list

Work carrying any of these tags is warranty, and is excluded from money at risk.

**In `tag_ids` (repair.tags):**

| Tag |
|---|
| Under EVS Warranty |
| UNDER EVS WARRANTY |
| SERVICE UNDER WARRANTY |
| Minor service under EVS warranty |
| First service under EVS warranty |
| Warranty checkup |
| PARTS ON ORDER - WARRANTY |
| INWarranty |
| Waypoint Warranty |
| WARRANTY CHECK AHMAD |
| WARRANTY ACTIVATE AHMAD |

**In `x_studio_stages_tags` (x_stages_tags):**

| Tag |
|---|
| WARRANTY |
| WARRANT |
| EVS WARRANTY |
| UNDER EVS WARRANTY |
| SERVICE UNDER WARRANTY |
| WARRANTY CHECKUP |
| Major services under EVS warranty |
| Minor service under EVS warranty |
| INDIVIDUAL  WARRANTY |

Note that `Major services under EVS warranty` carries a leading right-to-left
mark in Odoo, invisible on screen. It must be matched by tag id, not by name —
one more reason the list is a picker rather than a string match.

## Billable, despite containing the word

The six negations above, plus every administrative tag:

`LATE WARRANTY PAYMENT` · `WARRANTY OWNER NAME  CHANGE` · `WARRANTY BOOK` ·
`WARRANTY ACTIVATION` (three spellings) · `Warranty Activation` ·
`WARRANTY EXTENSION` · `ESTIMATE WARRANTY` · `WARRANTY CUSTOMER` ·
`OPEN WARRANTY` · `WARRANTY CANCELED` · `WARRANTY CONTRACT PACKAGE` ·
`WARRANT CONTRACT PACKAGE` · `WARRANTY CONTRACT AND SERVICE`

## Still undecided

Two tags have not been classified. They are currently treated as **billable**,
which is the choice that keeps money *in* the at-risk figure rather than quietly
removing it — the safer error while the question is open:

- `warranty need to active`
- `WARRANTY THOUGH APPLICATION`

## A job can be part warranty and part billable

A job was marked warranty if **any** of its lines carried the warranty flag, and
the whole job then left the figure. In a sample of 400 recent non-historical job
cards, **22** had both warranty and billable labour lines — about 7% of those
with any labour.

`repair.service.line` carries `value_aed`, and parts lines link back through
`stock.move.repair_id`, so the report can count the billable portion instead of
discarding the job. That is the fix.

## What the line flags are worth knowing

Both `repair.service.line.under_warranty` and `stock.move.under_warranty` are
**stored, writable booleans** — not computed, not defaulted. 40.5% of labour
lines and 20.3% of parts lines are flagged, so the signal is selective and
trustworthy. The flags were never the problem; the rule wrapped around them was.

`repair.order.under_warranty` is set on **zero** job cards, so the order-level
flag carries no information and nothing is lost by ignoring it.

## A third tag field, deliberately ignored

`x_studio_vehicle_tags_1` points at `fleet.vehicle.tag`, which holds seven tags
including `Waypoint Warranty` and `WARRANTY CANCELED`, present on 3,422 job
cards. It is not read, and should not be: a tag on the *vehicle* describes the
car's warranty status, not whether this particular visit is being done free.

## One fragility to watch

Tag names are resolved by reading each tag table with a limit of 500 rows.
`repair.tags` currently holds **430**. Past 500, tags beyond the limit become
invisible and the jobs carrying them silently stop being recognised as warranty.
Worth raising the limit before that happens.
