# MollyRun

A Mac panel for Python scripts. The scripts stay in their own projects. MollyRun registers them, starts and stops them, and shows their output in terminal tabs.

## Download

The current build for Apple silicon Macs is on the [releases page](https://github.com/mm22hh/MollyRun/releases). Unzip it and move `MollyRun.app` into Applications.

This build is not code-signed. The first time you open it, Control-click the app in Finder and choose Open.

## Develop

```bash
npm install
npm run dev
```

## Build an app

```bash
npm run dist
```

The result is `release/mac-arm64/MollyRun.app`. You can also drag it into Applications.

## Register a script

- A Python file
- An interpreter: the system Python, or a virtual environment
- Arguments, for example `--epochs 10`
- Or a single command, which runs directly in the terminal

When a virtual environment is selected, MollyRun starts that environment's Python and puts its `bin` directory at the front of `PATH`.

Closing a tab does not stop the script. If scripts are still running when you close the window, MollyRun asks first.
