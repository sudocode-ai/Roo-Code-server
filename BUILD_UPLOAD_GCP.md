# VSIX Building and Uploading

1. Build normally with `pnpm vsix` which will output to `../bin/roo-cline-[version].vsix` or some other configured location
2. To upload files to your roo-code-server repository in us-west1 under the sudocode-staging project, you can use the gcloud artifacts generic upload command.

```bash
gcloud artifacts generic upload \
    --source bin/roo-cline-[VERSION].vsix \
    --repository=roo-code-server \
    --location=[LOCATION] \
    --project=[PROJECT] \
    --package=roo-code-server-extension \
    --version=[VERSION]
```

```bash
gcloud artifacts generic upload \
    --source bin/roo-cline-3.23.19.vsix \
    --repository=roo-code-server \
    --location=us-west1 \
    --project=sudocode-staging \
    --package=roo-code-server-extension \
    --version=3.23.19
```
