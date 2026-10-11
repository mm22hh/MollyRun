# MollyRun

一台 Mac 上的 Python 脚本面板。脚本仍放在各自的项目里。MollyRun 负责登记、启动、停止，并用终端标签看输出。

## 运行

开发时：

```bash
npm install
npm run dev
```

打成独立应用：

```bash
npm run dist
```

完成后打开 `release/mac-arm64/MollyRun.app`，也可以把它拖进「应用程序」。

## 登记一项脚本

- Python 文件
- 解释器：系统 Python，或某个虚拟环境
- 参数，例如 `--epochs 10`
- 或者只填一条命令，启动后直接在终端里执行

选了虚拟环境之后，用里面的 Python 启动，并把该环境的 `bin` 放到 `PATH` 前面。

关掉标签不会停止脚本。关掉窗口时，如果还有脚本在跑，会先询问。
