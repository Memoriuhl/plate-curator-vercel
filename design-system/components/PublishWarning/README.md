# PublishWarning

The final step of Publish: an alert dialog that names the consequence ("You're about to push v42 to every player") and the counts. The **Push** button stays disabled until the version is typed. It opens only from the Publish page, after the checks have passed. Code: `components/publish/publish-warning.tsx` (shadcn AlertDialog), loaded on demand.
