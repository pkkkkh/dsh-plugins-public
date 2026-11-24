# image-toolbox

一个工具 `image_generate`：直连火山方舟（豆包 Seedream）出图，**没有任何客户端 UI**。
只依赖宿主 `tools` 服务 + Node 自带 `fetch`。

## 工具

| 工具 | 参数 |
| --- | --- |
| `image_generate` | `prompt`(必填)、`size`、`count`(1-4)、`model`、`saveDir` |

出图后落盘到 `outputDir`（默认 `D:\\Videos\\img`），返回本地文件路径。

## Key 的优先级

`config.apiKey` → 环境变量 `ARK_API_KEY` / `ARK_APIKEY` → `keyFile`（默认 `C:\\Users\\YOURNAME\\.dsh\\ark.key`）

没配 Key 时返回明确错误，**不出图不扣费**。

## 配置

| 字段 | 默认 |
| --- | --- |
| `baseUrl` | `https://ark.cn-beijing.volces.com/api/v3` |
| `model` | `doubao-seedream-5-0-flash-260915` |
| `outputDir` | `D:\\Videos\\img` |
| `size` | `1024x1024` |
| `keyFile` | `C:\\Users\\YOURNAME\\.dsh\\ark.key` |
| `apiKey` | 空（优先于上面两者） |

## 计费

按张计费（`count` 每张单独算）；失败不扣费。生图记录见 `~/.dsh/im/logs/image-gen-ledger.md`。
