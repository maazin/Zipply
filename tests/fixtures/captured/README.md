# Captured forms

Real application forms saved with the panel's **Save form** button. Values,
scripts, tokens and your own details are removed before saving.

Drop a file here and `npm test` runs it automatically (`tests/captured.test.ts`):
Zipply must detect it as an application and fill at least a few fields with the
test profile. When a real form fills badly, add an assertion for that form.
