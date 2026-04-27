# Fix horizontal scroll on "Barcha modullar" (course) page for mobile

## Root cause
`src/pages/CoursePage.tsx` has elements that overflow on a 375px viewport:
- `text-4xl` heading on long titles forces wider-than-viewport content.
- Grid/flex children lack `min-w-0`, so long words push past the viewport edge.
- Lesson row uses `truncate` inside a flex parent that itself can overflow.

## Changes (single file: `src/pages/CoursePage.tsx`)

1. Add `min-w-0` to the outer grid, both columns, and the heading wrapper so flex/grid children can shrink.
2. Make typography responsive:
   - Course title: `text-2xl sm:text-3xl lg:text-4xl` (was `text-4xl`)
   - Tagline: `text-base sm:text-lg` (was `text-lg`)
   - Module title: `text-base sm:text-lg`
3. Add `break-words` to title, tagline, description, module title/summary, and lesson title — and replace the lesson title's `truncate` with `break-words` so long Cyrillic/Uzbek words wrap rather than overflow.
4. Tighten card padding on mobile (`px-4 sm:px-5`) so module cards don't push past container padding.
5. Mark the check icon and duration block as `shrink-0` so the lesson row layout stays stable when wrapping.
6. Make the "Take quiz" button full-width on mobile with a 44px tap target.
7. Bump lesson row min-height to 44px for tappability.

No changes to data fetching, routes, sidebar progress card content, or i18n.

## Verify
At 375px width on `/course/:courseId`:
- No horizontal scroll.
- Long lesson titles wrap onto a second line instead of being clipped or pushing the page.
- Module cards fill width, "Take quiz" button is full-width.
- Sidebar (progress card) stacks below the modules, no overflow.
