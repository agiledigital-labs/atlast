# Atlast CLI interface

A CLI tool for managing Jira projects and Confluence spaces.

## Node usage

After compilation using the `npm run build` command, run all commands using `./dist/atlast <Command name>`.

## Common/Global parameters

All `atlast` commands require connecting to the Atlassian management APIs. The recommended way of doing this is to create an [API token](https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/).

The API token can be supplied to the tool by setting the `ATLAST_PW` environment variable or using the `--pw` command line argument (not recommended).

Run `atlast --help` to see a list of available commands.