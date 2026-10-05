---
name: write-pr
description: Write the pull request title and description from the plan and your changes.
---
After the work is done, write the PR description as part of your handoff, under "## PR":

- **Title:** under 70 characters, imperative ("Add …", "Fix …"), no ticket prefixes unless the repo uses them.
- **Summary:** at most 3 bullets: what changed and why. Write for a reviewer who has not seen the plan.
- **How it was tested:** the commands you ran and their result, plus any manual checks.
- **Notes for reviewers:** only if something is surprising or risky. Otherwise leave it out.

Do not list every file. Do not claim tests passed unless you ran them in this session.
