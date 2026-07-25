## Outcome

<!-- What user-visible or architectural outcome does this change produce? -->

## Scope

<!-- List the important files/components and explicitly note any security-boundary change. -->

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run desktop:build` when relevant
- [ ] Relevant integration/platform tests
- [ ] `npm audit`

## Safety checklist

- [ ] No API keys, local `.deep-mix` state, private evaluation data, or personal paths
- [ ] Workers remain isolated and side effects still use the permissioned Tool Runtime
- [ ] Public behavior and known limitations are documented
- [ ] The diff contains no unrelated generated files or formatting churn
