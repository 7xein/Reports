# Who should own which KPI — read from Odoo, 12 November 2026

Read directly from the live Odoo 18 instance over read-only JSON-RPC, counting
who actually performed each KPI-bearing action in the **last 90 days**, per
branch, across the five UAE main branches the KPI section scores.

Method: `create_uid` for records (job cards, quotations, purchase orders,
invoices) and chatter authorship of the tracked state transition for actions
(moved to Inspection, through QA, marked Repaired, quotation confirmed, purchase
order confirmed). Nothing was written to Odoo.

---

## 1. The correction that matters most

**Mohammed Ansari does not raise RFQs.** He is configured as Dubai's RFQ
coordinator in `rfqCoordinators`, which means every KPI 18 verdict for Dubai —
hits and misses alike — is charged to him. In 90 days he raised **no** RFQs.

What he actually does in Dubai: **writes 433 quotations** and **moves 376 repair
orders through QA**. So his KPIs are 12, 21 and 16 — not 18.

Dubai's actual RFQ raiser is **Mohammed Alkhateeb (552)**. Two Mohammeds; an easy
confusion, and it has been charging the wrong man for the whole branch's parts
procurement.

## 2. KPI 18 (RFQ after approval) — the correct owner per branch

| Branch | Configured today | Actually raises RFQs | Verdict |
|---|---|---|---|
| Dubai | Mohammed Ansari | **Mohammed Alkhateeb (552)**, Wajid Sain (175) | **wrong person** |
| Ajman | Aghyad | **Mohammad Affan (413)**, Aghyad (81) | understated — Affan does 5× more |
| Abu Dhabi | Harris | **Harris (756)** | correct |
| Sharjah | *nobody* | **Jaymohen (705)** | unassigned — falls to whoever opened the job card |
| Al Ain | *nobody* | **Yahia Tayane (277)** | unassigned — falls to whoever opened the job card |

Only one of five is right today. And because `rfqCoordinators` holds **one**
person per branch, Wajid Sain's 175 Dubai RFQs and Aghyad's 81 in Ajman cannot
be scored at all even once the primary name is corrected.

## 3. There are three roles in this business, not two

The config offers two sections — advisor and workshop. The data shows three
clearly separated groups of people, and the parts role fits neither.

**Service advisors** — open job cards, write quotations, confirm them, raise the
invoice:

| Branch | People |
|---|---|
| Dubai | Ramez AlHawamdeh, Mzee Mcharo, Shahenda Ashraf, Mubasheer Ali, Ladie Remaldora (confirms 841, invoices 1310) |
| Ajman | Ahmed Abdallah, Hamza Abdalla, Yogendra Shetty |
| Sharjah | JAAFAAR ADNAN HAMAD, Rakan Ratrout, Amin Ahmed |
| Abu Dhabi | Hassan Halawa, Oxana Yussufova, Melissa Salah, Feras Alnabelsi, Khytly Miranda |
| Al Ain | Hamsa Salloum, Hani Hamoude, Tarteel Ali |

**Workshop / stage controllers** — move cars to Inspection, through QA, and mark
them Repaired. They write no quotations and raise no invoices:

| Branch | People |
|---|---|
| Dubai | Loai Sami (1,393 to Inspection), Sief Ahmad (1,551 marked Repaired) |
| Ajman | Aqeel Ahmad (475), Sandeeb Ramankutty |
| Sharjah | Abdulaziz Abdulqasim (607) |
| Abu Dhabi | Khytly Miranda, Mohammed Lahbichi |
| Al Ain | Sheikh Fareed (1,097 to Inspection, 941 Repaired), Hamza Ismael, Navinda Nawarathe |

**Parts and purchasing** — raise RFQs and confirm purchase orders, and do
nothing else:

| Branch | People |
|---|---|
| Dubai | Mohammed Alkhateeb, Rami Jallad (confirms 507 POs) |
| Ajman | Mohammad Affan, Shamsheer Kalathil |
| Sharjah | Jaymohen, Safdar Shaikh, Adham Nashaat |
| Abu Dhabi | Harris, Khaldoun Abo Shameh, Said Muhammed |
| Al Ain | Yahia Tayane, Mohamad Sultan |

Under the two-section model these people are miscategorised whichever way they
are filed: as advisors they are scored on quotation and invoicing KPIs they never
touch, and as workshop they are scored on inspection and QA timings they never
touch. Either way their real KPIs — 18, 19, 20 — reach them only through the
single-person `rfqCoordinators` override.

## 4. One person spans every branch

**Youssef Ashraf** opens job cards and writes quotations in **all five
branches**: Dubai 149, Abu Dhabi 281, Al Ain 172, Ajman 154. A roster entry holds
one branch, so four-fifths of his work scores a branch while appearing on his
card under a different one. **Faisal Javed** spans Ajman, Abu Dhabi and Al Ain;
**Khaldoun Abo Shameh** spans Ajman and Abu Dhabi; **Rami Nadim** spans Sharjah
and Dubai.

This is section 7's cross-branch finding, now with names.

## 5. Central staff and robots are scoring branches but sit on no card

**Clarice Urbiztondo** and **Rachel Aritalla** raise RFQs and confirm purchase
orders in **all five branches** — a central purchasing function. **OdooBot**
appears in all five (writes 62 quotations in Sharjah, raises RFQs everywhere),
and **Administrator** in two.

Only 41 people are rostered. Unless these are among them, their work counts at
branch level and reaches no individual — the off-roster hole in section 7.
OdooBot's activity in particular is automation, and should never be scored.

## 6. KPI 13 cannot be scored at all

Two independent reasons, both now confirmed against Odoo:

1. **`repair_is_qa` is a computed, non-stored, readonly field** — Odoo recomputes
   it for whoever reads it. It is a button-access flag, so KPI 13's population is
   governed by the API user's permissions, not by the record.
2. **Nobody can be identified as the uploader.** `follow_up_screenshot` is a
   binary field and binary fields are not chatter-tracked, so the best available
   signal is who last wrote the record. That signal is worthless here: it returns
   *nobody* in Dubai, and in Ajman it returns **Hussein Eldomor (655)** — the
   owner's own administrative writes, not the advisors' uploads.

KPI 13 should be switched off until it filters on a stored field that records the
QA step and until the upload itself is attributable.

## 7. Concentration risk worth knowing

**Al Ain runs on one person.** Hamsa Salloum writes 1,588 quotations, confirms
1,903 and raises 2,325 invoices — essentially the whole branch's advisor
workload. Her individual KPI scores and Al Ain's branch scores will be close to
the same number, so an incentive scheme cannot distinguish her performance from
the branch's.

The same shape, less extreme: **Ladie Remaldora** carries Dubai's confirmations
(841) and invoicing (1,310); **Sheikh Fareed** carries Al Ain's workshop stages.

## 8. What this implies for the configuration

1. **`rfqCoordinators` must hold a set, not a person.** The owner's rule is
   "anyone who raises RFQs gets that KPI", and four of the five branches have a
   second or third raiser whose work currently cannot be scored.
2. **Correct Dubai from Mohammed Ansari to Mohammed Alkhateeb**, and add Wajid
   Sain. Add Mohammad Affan to Ajman alongside Aghyad. Set Sharjah to Jaymohen
   and Al Ain to Yahia Tayane.
3. **Add a third section for parts and purchasing**, owning KPIs 18, 19 and 20 —
   or, better, replace the two-section model with per-KPI owner sets, which is
   what the `rfqCoordinators` pattern already is for one KPI.
4. **Decide who owns KPIs 1 and 11.** They measure Repaired → invoice posted, and
   in every branch those are different people: the stage controller marks
   Repaired, the advisor raises the invoice. This is a business choice, not a
   technical one.
5. **Exclude OdooBot and Administrator from scoring entirely.**
6. **Decide what to do about Youssef Ashraf and the other cross-branch staff** —
   either accept that their score sits under one branch, or let a roster entry
   carry more than one.

## Caveats on the method

- **"Raises customer invoices" uses `create_uid` on `account.move`**, which is who
  created the invoice, not necessarily who posted it. For KPIs 1 and 11 the
  posting moment is what is measured; if the two differ in practice, this column
  names the wrong person and should be re-read from the posting transition.
- **"Confirms quotations" and "Confirms purchase orders"** come from chatter
  authorship of the state transition, which is the person whose click caused it.
- Counts cover 90 days and so include anyone who has since left.
- The five Enoc companies are children of these branches but sit in no branch
  cluster, so any work booked to them is absent from every figure above.
