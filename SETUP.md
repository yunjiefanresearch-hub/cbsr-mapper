# Deploying this repo

## The one thing that goes wrong

This folder contains a hidden directory, `.github/`, which holds the deploy workflow.
**Finder and File Explorer do not show it**, so dragging the folder into GitHub's
"Add file → Upload files" box silently uploads everything *except* the workflow. The push
succeeds, the files look right, and no Action ever runs.

One other hidden file matters: `.gitignore`.

Check with:

```bash
ls -a          # you should see .github and .gitignore
```

## Push it (this uploads hidden files correctly)

```bash
cd cbsr-mapper
git init
git add -A
git commit -m "CBSR mapper"
git branch -M main
git remote add origin git@github.com:<you>/cbsr-mapper.git
git push -u origin main
```

Then: **Settings → Pages → Build and deployment → Source → GitHub Actions.**

Not "Deploy from a branch". With the wrong source the workflow still runs but fails at
the last step, which looks like a broken build rather than a setting.

## If you must use the web uploader

Upload the visible files by dragging, then create the workflow by hand — the web editor
accepts a path with slashes and makes the directories for you:

1. **Add file → Create new file**
2. Name it exactly: `.github/workflows/deploy.yml`
3. Paste the contents of that file from this folder
4. Commit

## Verify

- `https://github.com/<you>/cbsr-mapper/blob/main/.github/workflows/deploy.yml` opens (not 404)
- The **Actions** tab shows a run
- Settings → Actions → General is set to "Allow all actions"

## If the Actions tab is empty and the file is there

The workflow triggers on `push` to **`main`**. If your default branch is `master`, either
rename the branch or change the branch name inside `.github/workflows/deploy.yml`.

## What the workflow does

Runs `npm install`, then the register invariants **before** the build — a violated
invariant should stop a deploy, not be discovered inside one — then `npm run build`, which
re-runs them against `dist/` so a placeholder cannot reach production even if it only
appears after bundling. Seven invariants: record and citable counts match the data, all 66
jurisdiction pairs and 132 directed corridors are present, the corridor evidence contract
holds with no half-states and nothing citable-while-pending.

There is no `package-lock.json` and the workflow uses `npm install`, not `npm ci`, so
nothing needs regenerating before you push.

## Deploy this one first

`cbsr.io` embeds this site in an iframe. Deploy the mapper first and the embed is live the
moment the landing page goes up. If your repo is not named `cbsr-mapper`, update the one
`MAPPER_URL` line in `cbsr.io/index.html`.
