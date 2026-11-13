# Set up the CBSR mapper

Follow the [build and hosting instructions](DEPLOY.md) to use the locked dependencies and the pinned sibling register checkout.

For GitHub Pages, use Git to include the hidden `.github/` directory when pushing a fork. Select GitHub Actions as the Pages source and confirm that the [deployment workflow](.github/workflows/deploy.yml) appears in the Actions tab. The workflow publishes on pushes to `main`.
