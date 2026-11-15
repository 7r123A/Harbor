# Social Reviews + Mutual Ratings — progress

One source of truth for this project. Read this first in a new session, then inspect the
files named here before changing anything.

Branch: `feat/social-all` (frontend, unpushed), `main` (backend, unpushed since `7fc60c4`).

## Master checklist

Statuses: Not started · In progress · Implemented, not verified · Verified complete · Blocked

### Part 1 — poster friend avatars

| # | Task | Status | Notes |
| --- | --- | --- | --- |
| 1.1 | Stop avatars colliding with New/awards | Verified complete | avatars left the poster area entirely; the top badge strip is untouched |
| 1.2 | Move avatars below poster **and** below the title, compact `+N` row | Verified complete | row is 15px tall with 0.5 gaps, 14px avatars and a 1px ring, sitting `mt-0.5` under the title so it belongs to the card |
| 1.3 | Grid alignment: reserved avatar row, stable card height | Verified complete | the row is always rendered at `h-[18px]`, so cards with and without friends match |
| 1.4 | Works with every poster variant/customization/size/ratio | In progress | row is inside `PickCard` below the reused title block, so scale/aspect are inherited; still needs a sweep of the card-size and hide-title settings |

### Part 2 — Mutual Ratings on the real profile

| # | Task | Status | Notes |
| --- | --- | --- | --- |
| 2.0 | Backend `GET /social/u/{handle}/mutual` (scores, diffs, both reviews, likes/comments, sort, paging, score) | Verified complete | `social/features/mutual-ratings.js`, 11 checks |
| 2.1 | Mutual section inside the profile ratings area | Implemented, not verified | `src/views/profile/mutual-ratings-card.tsx`, mounted next to `RatingsCard` in `profile.tsx` |
| 2.2 | Match score badge with colour ranges + count + empty state | Implemented, not verified | five bands, count, "small sample" note under 5, empty state at `score == null` |
| 2.3 | Side-by-side review comparison, all four presence cases | Implemented, not verified | each row expands to two columns, "No written review" per side; no invented summary |
| 2.4 | Verified on own profile (no self-compare) and others' profiles | In progress | card returns `null` when `isOwner`; needs a browser pass once the backend is deployed |

### Part 3 — Quick Access

| # | Task | Status | Notes |
| --- | --- | --- | --- |
| 3.1 | With review filter actually filters | Implemented, not verified | `withReview=1` chip drives the server param; backend filter + 20-check suite green |
| 3.2a | Like button (heart) replaces the reaction star, optimistic + persisted | Implemented, not verified | `likeReview`/`unlikeReview` in each row |
| 3.2b | Comment button opens the thread and posts replies inside quick access | Not started | count is rendered; `loadReviewThread`/`replyToReview` exist |
| 3.3 | Posters noticeably larger | In progress | 72×50 now, still small for the request |
| 3.4 | Readability of text, dates, counts, names | Implemented, not verified | larger type + relaxed leading |
| 3.5 | Most liked / most commented sorting | Implemented, not verified | backend `sort=liked|commented`; select offers them |
| 3.6 | Reuse the real profile hover card in Social Reviews | Not started | pick the card used on profiles, do not fork it |

### Part 4 — friendship state in Quick Access

| # | Task | Status | Notes |
| --- | --- | --- | --- |
| 4.1 | Add friend disabled/faded when already friends, tooltip "This user is your friend." | Implemented, not verified | `friendRowState` drives it; the faded button is wrapped in a span because a disabled button swallows its own tooltip |
| 4.2 | Subtle friend icon next to the name | Implemented, not verified | same `friendship` state as the button |

## Backend files

- `services/harbor-themes/src/ecosystem/social/features/mutual-ratings.js` — mutual endpoint
- `services/harbor-themes/src/ecosystem/social/reviews.js` — `withReview` on author reviews
- `services/harbor-themes/src/test/social-mutual.js`, `test/social-quick-menu.js` — coverage

## Frontend files

- `src/components/ratings/reviewer-quick-menu.tsx` — quick access: likes, with-review chip, friend state, typography
- `src/components/pick-card.tsx` — friend avatars placement
- `src/components/ratings/review-card.tsx` — the full reviews list card (untouched this pass)
- `src/chrome/account-menu/account-menu-panel.tsx` — Messages entry
- `src/components/dm/dm-launcher.tsx` — floating pill removed

## Test results

- Backend: `node services/harbor-themes/src/test/run-all.js` → 21/21 suites pass, 11 skipped
- Frontend: `npx tsc --noEmit` clean, `npx vite build` ok (last run before the friendship/like edits;
  re-run after them)

## Next steps, in order

1. Run `npx tsc --noEmit` and `npx vite build`; verify likes and the with-review filter in the browser.
2. `pick-card.tsx`: move the avatar row from above the poster to below the title, reserve its height
   (fixed `min-h` on the row) so cards without friends do not shift, and check every card variant.
3. Comment thread inline in quick access (`loadReviewThread`, `replyToReview`).
4. Mutual Ratings section in `src/views/profile/ratings-card.tsx` + score badge + comparison view.
5. Reuse the profile hover card in quick access.
6. Re-check the New/award badge strip once the avatars live below the title.
