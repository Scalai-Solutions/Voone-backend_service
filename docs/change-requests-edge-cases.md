# Editing rewards, treatments, levels and bonos: rules and edge cases

Who this is for: Voone admins and engineers. It explains what every edit does, what refuses it, and
what a person sees when it does not work. The step-by-step procedure is in
[`change-requests-usage-flow.md`](./change-requests-usage-flow.md).

Everything here was read from the code (backend `src/modules/onboarding`, `src/modules/change-requests`,
`src/modules/treatments`, `src/modules/bonos`; frontend `src/components/admin/program`,
`src/components/dashboard`). Where something was not verified in a browser, it says so.

## 1. The four things that are easy to confuse

| Thing                       | What it is                                                                                                               | Who changes it                                                  | Does it change what members get?                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------- |
| **Ticket** (change request) | A message from the owner asking for a change. Statuses: Open, In progress, Resolved, Rejected.                           | Owner creates; admin moves it.                                  | No. Resolving a ticket only closes it and sends a note. |
| **Catalogue**               | The clinic's treatments and products (price, category).                                                                  | Admin, by applying a SERVICE_* ticket or in the catalogue step. | Only through a programme built from it.                 |
| **Programme**               | The reward ladder, levels and perks. Has versions: **draft** (BORRADOR), **active** (ACTIVO), **replaced** (SUSTITUIDO). | Admin edits a **draft** and **publishes** it.                   | Yes, once published.                                    |
| **Flag / chart**            | Estimates of five-year money. Read-only.                                                                                 | Nobody; they are computed.                                      | Never.                                                  |

The most common mistake: marking a REWARD or LEVEL ticket "Resolved" and expecting the clinic's Rewards tab
to change. It does not. The tab shows the **active programme**. The programme changes only when a draft is
edited and published.

## 2. What changes what

| Action                                       | Changes the programme?                                         | Changes the 5-year chart?   | Takes effect for the clinic when                                     |
| -------------------------------------------- | -------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------- |
| Swap a reward ("Cambiar")                    | Yes, in the draft                                              | Yes (after the draft saves) | The draft is published                                               |
| Rename a reward (pencil)                     | Label only                                                     | No                          | The draft is published (already-issued rewards keep their old title) |
| Edit a perk's name or description            | Text only                                                      | No                          | The draft is published                                               |
| Edit or hide a tier benefit line             | Words/visibility only; the real discount or perk keeps working | No                          | The draft is published                                               |
| Add or remove a clinic-written benefit       | Yes, in the draft (the tier's whole custom list is saved)      | No                          | The draft is published                                               |
| Edit a treatment's price or name (catalogue) | No. The programme keeps its own catalogue copy                 | No                          | A **new draft is generated** from the catalogue and published        |
| Add a treatment                              | No                                                             | No                          | Same as above                                                        |
| Remove a treatment                           | No (a reward using it stays in the programme)                  | No                          | Same as above; the admin gets a warning                              |
| Resolve / reject a ticket                    | No                                                             | No                          | Immediately, as a status and an email                                |
| Change Clients / Average ticket in the chart | No                                                             | Yes, immediately            | Never (a what-if only)                                               |

## 3. Rewards: the swap ("Cambiar")

The admin changes a reward in the programme editor. A swap is not "put this item there": it re-derives
cost, guarantees and the recurring reward, and refuses only what would break a promise to clients.

### 3.1 When a swap works

All of these must hold:

1. **The programme is a draft.** An active programme cannot be edited. Error: "Solo se pueden cambiar los
   premios de un borrador. Genera un borrador nuevo para editar un programa activo."
2. **The milestone holds a reward.** Perk and "level up" rows have no reward. The editor no longer offers
   "Cambiar" on them. If it is called anyway (an old page, an API call) the answer is
   "Ese hito no tiene un premio que se pueda cambiar." This was the cause of that message appearing "sometimes":
   the button used to show on perk rows such as "Diagnóstico corporal gratis" and "Puntos dobles en tu próxima visita".
3. **The item can be a reward.** It must exist in the clinic's catalogue **as it is today**, have a price
   above 0, have a category, and not be a medical treatment or product.
4. **No repeated gift in a row.** After the swap, no two consecutive **reward** milestones may share an item.
   Combo rewards count: one shared item is a repeat. Perk and level rows between them do not count, which is why a
   message can say "milestones 1 and 3" (milestone 2 is a perk).
5. **Nobody saved the draft meanwhile.** Otherwise: "El borrador ha cambiado mientras lo editabas. Recarga la
   página y vuelve a intentarlo."

### 3.2 What is allowed (and is not an error)

- A **dearer** reward. If the plan's total cost exceeds 1.5 times its investment, a cost note is added. It is
  information for the admin and **does not block publishing**.
- A **cheaper** reward, or rewards out of price order, or a Bronce-first ladder that no longer climbs.
- Swapping the **last** reward: the recurring reward ("after Diamante") is re-picked so it stays worth at least
  as much. If nothing fits, the old recurring reward stays.
- Choosing the item the milestone already holds.

### 3.3 Edge cases

| Situation                                                             | Result                                                                                                                                      |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| The programme **already has** a repeat elsewhere in the ladder        | **Every** swap is refused with that repeat's message, because the whole ladder is checked, not only the changed row. Fix that repeat first. |
| The item was **added to the catalogue after** the draft was generated | Works (fixed: the swap now reads the item's current row). Before the fix it said "Ese artículo no está en el catálogo".                     |
| The item was **repriced after** the draft                             | It is priced at today's price (before the fix it used the stale price, so "Reward value" could disagree with the catalogue).                |
| The item was **deleted** from the catalogue                           | "Ese artículo no está en el catálogo."                                                                                                      |
| The item has **no price**                                             | "Ese artículo no tiene precio, así que no puede ser un premio."                                                                             |
| The item has **no category**                                          | "Asigna una categoría a este artículo en el catálogo antes de usarlo como premio."                                                          |
| The item is **medical**                                               | "Los tratamientos y productos médicos no se pueden dar como premio."                                                                        |
| An **alternative** ("Usar este") that no longer exists                | "Esa alternativa no existe."                                                                                                                |
| The swapped-out reward                                                | Becomes an alternative of that milestone, so it can be undone.                                                                              |
| Alternatives on **other** milestones that use the new item            | Removed, to avoid the same item twice in the ladder.                                                                                        |
| A **label** (renamed title) on the milestone                          | Deleted by the swap: it described the reward that left.                                                                                     |
| Two admins swap at once                                               | One wins; the other gets the "El borrador ha cambiado" message.                                                                             |

### 3.4 Reading the milestone row

```
Higiene facial Detox / Limpieza facial básica  ✎      30 €   [Cambiar]
Restaurar nombre original
Reward · month 1 · Reward value 60 €
```

- **`30 €` on the right** is what the customer must have **spent** to reach this milestone. A swap never changes it.
- **"Reward value"** is the reward's **retail price** (the item's catalogue price; a combo shows the sum). This is
  the number that tells you which item is behind the row. It is shown to admins only.
- **The pencil** changes only the displayed title. The reward and its value stay the same. The edit box says so.
- **"Restaurar nombre original"** appears on **every** reward row, renamed or not. It is not a sign that the name was edited.
- **"Cambiar"** is the only control that changes the reward.

### 3.5 Publishing a draft

- Blocking review notes (an unclassified catalogue row, answers that contradict the catalogue) refuse the publish:
  "El programa tiene avisos que resolver antes de activarlo: ...". The cost note is **not** one of them.
- A draft already replaced by a newer version cannot be published ("Ese programa ya fue sustituido...").
- Publishing marks the previous active version as replaced (never deleted) and **re-places every member** on the
  new ladder by what they have spent. Rewards already issued stay valid until they expire. A step already passed on
  the new ladder is not issued again.
- Every member's wallet card is refreshed (the card shows the next reward).
- A first-ever publish does not migrate members from an old scheme.
- Only one draft may exist per clinic. Creating another says "Ya hay un borrador (versión N). Edítalo o actívalo
  antes de crear otro."
- A draft cloned from the active programme carries its **old output and catalogue copy**: it does not pick up
  catalogue changes by itself.

## 4. The owner's "Request a change" form and its flag

### 4.1 Reward request

- **Replace with** is a searchable catalogue list **plus** free text. An item from the list is priced; free text is
  **worth €0** and is "Sin valorar".
- The reason is required (3 to 2000 characters).
- Under the picker the owner sees a flag. It simulates the swap on a copy of the **active** programme with
  **today's** catalogue and compares five years against the current plan and Voone's recommended plan.

| What the owner picked                                      | What the flag shows                                                                                                                                                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A valid item that changes the money                        | Signal ("Good option", "Costs more", "Similar") and a 5-year sentence, ▲ ＝ ▼ per year against the current plan and against Voone. Hover a mark for euros (rounded to €100) and percent (rounded to 5). |
| A valid item with almost no effect                         | "Similar", and the marks read ＝. A mark whose rounded euros are 0 reads ＝.                                                                                                                            |
| Free text                                                  | "Sin valorar": Voone will value it when reviewing. No comparison.                                                                                                                                       |
| An item that would repeat a gift in consecutive milestones | "No se puede comparar": "Ese regalo quedaría repetido en dos hitos seguidos. Elige otro artículo."                                                                                                      |
| An item with no price/category, or medical                 | "No se puede comparar": "Ese artículo no se puede dar como premio. Elige otro."                                                                                                                         |
| Anything else that cannot be simulated                     | **Nothing shown.** See the list below.                                                                                                                                                                  |

**Shows nothing** when: there is no active programme; the item is not in the clinic's catalogue (including another
clinic's); the milestone is not a reward; the request has no item (only a milestone); the daily/minute limit is hit
(429); or an internal error occurred. A flag never blocks the form: the owner can still submit.

**Vs Voone ▼ in every year** means the engine's own recommendation would do better. It is not an error and does not
stop the request.

**Vs Voone row missing** means the programme has no stored recommendation. The owner is then compared only with
the current plan.

### 4.2 Service price request

- Flag appears only if the service is a **live reward** (used by a milestone or the recurring reward).
- Price is simulated rounded to the nearest €5 for the owner (minimum €5). Voone sees the exact price.
- Not modelled, so no flag: a name-only edit, a category change, and a service that is not a reward. For a service
  that is also the referral gift or a birthday gift, the effect is understated; if it is only that, no flag.
- Typing the current price changes nothing and reads as "same".

### 4.3 Limits that apply to the flag

- 30 previews per minute per clinic, and 200 per 24 hours.
- Only OWNER and MANAGER may preview. Owners never receive a gift's cost or value, exact euros, or Voone's own figures.
- The flag uses standard model values, not the clinic's measured data.
- The browser can translate the page. The picker and flag are safe under Chrome translate (item names are
  marked do-not-translate).

## 5. Treatments and services

### 5.1 What the owner asks for

Types: SERVICE_ADD, SERVICE_EDIT (name, price, category), SERVICE_REMOVE. Services are read-only for the owner; every
change is a ticket.

### 5.2 What "Apply" does (admin)

Apply makes the change to the live catalogue and closes the ticket in one step.

| Situation                                                          | Result                                                                                             |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Ticket already closed                                              | Refused (409).                                                                                     |
| Ticket type not applicable (REWARD, LEVEL, OTHER)                  | Refused. Use the programme editor or resolve by hand.                                              |
| The target treatment no longer exists                              | "The target treatment no longer exists at this clinic." Ticket stays open.                         |
| Values not valid (price range, etc.)                               | "The proposed values are not valid for the catalogue: ...". Ticket stays open.                     |
| SERVICE_ADD without a category at a clinic that uses the catalogue | The ticket shows `needsCategory`; the admin must pick a category before applying.                  |
| Applied twice (even after a reopen)                                | Second apply is refused (409). A reopened applied ticket can only be resolved or rejected by hand. |
| Removing the **last** treatment                                    | Refused: it would flip the scan screen back to an old table.                                       |
| Removing a treatment                                               | Hard delete from the catalogue. Visit history is unaffected; members keep rendered reward text.    |

### 5.3 What Apply does **not** do

- It does **not** change the programme. The programme keeps the catalogue copy it was generated with.
- A reward that uses an edited or removed treatment **stays in the programme** with its old price and cost.
- So a treatment repricing never moves the 5-year chart or "Reward value" of an existing programme.

To make a catalogue change count, generate a **new draft** from the catalogue (it re-runs the engine), review it,
and publish it. A draft **cloned** from the active programme does not do this.

### 5.4 Warnings the admin sees (never blocking)

With an active programme, an open SERVICE_* ticket (and the apply result) lists:

- "Applying this will change the catalogue compared with the active programme (vN): consider recalibrating."
  After applying: "The catalogue changed since the active programme (vN) was built: consider recalibrating."
- For an edited or removed treatment: each live reward using it, e.g. `Milestone 3 reward "Bio-Pen" uses this treatment.`

No warnings are shown for closed tickets, bono tickets, or clinics with no active programme.

### 5.5 The admin's comparison on a service ticket

- "That service is not a live reward." means the treatment is not used as a reward, so there is nothing to compare.
- "Category and name changes are not modelled." and "The edit does not change the price." are the other reasons.

## 6. Levels (Niveles)

- A LEVEL ticket asks for a change to a tier's benefits; there is no flag for it.
- The admin edits tier benefit lines in the draft. Two kinds of line behave differently:
  - **Lines the clinic wrote**: part of the tier's list; every change saves the tier's whole custom list.
  - **Generated lines**: display only. Editing or hiding one changes the words or visibility; the real discount,
    multiplier or perk keep working. A hidden line stays listed (muted) so it can be shown again; an edited one can be restored.
- A tier must keep at least one visible line (422 otherwise).
- Like everything in the programme, level edits are draft-only and take effect on publish.

## 7. Bonos

- A BONO ticket carries an `action`: add, edit or remove. Add needs name, price and total sessions. Edit and remove
  need the plan.
- Remove: a plan no member has ever held is **deleted**; one that has been issued is **retired** (inactive, hidden
  from pickers) so members keep their bonos.
- No flag, no programme impact, no catalogue-drift warning.

## 8. Tickets: lifecycle and limits

| Rule                         | Detail                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transitions                  | Open → In progress / Resolved / Rejected; In progress → Open / Resolved / Rejected; Resolved or Rejected → Open only.                                                      |
| Resolve / reject need a note | The owner receives it by email, and it is kept in the thread.                                                                                                              |
| Reopen window                | The owner can reply or reopen within **14 days** of closing; after that it is refused (409). An admin can reopen at any time.                                              |
| Open-ticket cap              | At most **20** open or in-progress tickets per clinic.                                                                                                                     |
| Duplicate protection         | The same person, type, title and reason within **60 seconds** is treated as a retry: one ticket, one notification.                                                         |
| Field sizes                  | Title 1–120, reason 3–2000, message 1–2000, note up to 2000. Reward free text up to 120.                                                                                   |
| Linked programme             | A REWARD/LEVEL ticket can link one draft. Several tickets can share one draft. Linking moves Open → In progress.                                                           |
| Resolve linked               | After publishing, all open tickets linked to that programme are resolved with one note and their owners emailed. Only for an **active** programme.                         |
| Email                        | Best effort. A failure never blocks the ticket; it is recorded on the ticket (`lastEmailError`). Owners are the clinic's OWNER users, else the billing email, else nobody. |
| Languages                    | Owner screens and emails are Spanish; admin screens are English except the programme editor, which is Spanish.                                                             |

## 9. The five-year chart ("What the program costs and what it generates")

- It simulates five years of the **stored programme shown above it** for the given Clients and Average ticket.
- Costs use what each reward costs the **clinic** (retail price × the category's cost share, adjusted for
  occupancy), not the retail price. Only 75% of rewards are assumed to be redeemed.
- Defaults come from the programme's own answers. Valid ranges: clients 10–5000, ticket €10–€1000.
- After a swap the chart is asked again at once (fixed). Before the fix it kept the cached answer for up to a minute.
- Renames, perk text and level text do not change it. Treatment price edits do not change it for an existing programme.
- The separate **comparison** of a draft against Voone's recommendation uses the same model.
- The model's percentages (new-client mix, retention, redemption, referral share) are the founders' estimates, not
  measured data.

## 10. Messages and what to do

| Message                                                             | Cause                                                                                      | What to do                                              |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Ese hito no tiene un premio que se pueda cambiar.                   | Swap on a perk or level row (or a stale page).                                             | Swap on a reward row; reload.                           |
| Ese cambio repetiría un regalo en dos hitos seguidos (hitos A y B). | The new item shares a gift with a neighbouring reward, or the ladder already had a repeat. | Pick another item, or fix the existing repeat.          |
| Ese artículo no está en el catálogo.                                | The item is not in the clinic's catalogue.                                                 | Add it in the catalogue first.                          |
| Solo se pueden cambiar los premios de un borrador.                  | The programme is active.                                                                   | Open the programme editor (creates a draft), then edit. |
| Ya hay un borrador (versión N).                                     | A draft already exists.                                                                    | Edit or publish it.                                     |
| El borrador ha cambiado mientras lo editabas.                       | Someone saved it first.                                                                    | Reload and retry.                                       |
| El programa tiene avisos que resolver antes de activarlo.           | Blocking review note.                                                                      | Fix the note it names, then publish.                    |
| That service is not a live reward.                                  | The treatment is not used by the programme.                                                | Nothing to compare; apply it as a catalogue change.     |
| The target treatment no longer exists at this clinic.               | Treatment deleted since the request.                                                       | Resolve by hand or reject.                              |
| No se puede comparar (owner form)                                   | The pick is invalid for the programme.                                                     | Pick another item.                                      |

## 11. Known limits

- A rename is a label on a reward; the app does not show which rewards are renamed.
- The flag and the chart use standard values. A clinic's real numbers are not used.
- A treatment price change does not reach an existing programme without a new draft.
- The flag's per-minute limit is per server instance; a deploy resets it.
- A SERVICE_EDIT flag understates items that are also the referral gift or a birthday gift.
- A no-op price at a value that is not a multiple of €5 is simulated at the nearest €5.
- Not verified in a browser at the time of writing: the chart refresh after a swap, the hidden "Cambiar" on perk rows,
  and the pencil hint.
