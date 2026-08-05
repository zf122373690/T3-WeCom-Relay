# 企业微信成员 ID 查询与修改回调

这是一个独立的企业微信接收消息服务。成员向企业微信应用发送消息后，服务验签、
解密消息并查询成员 `userid`，随后通过加密被动回复直接把 ID 返回给该成员。
服务也可以使用通讯录同步凭证，让成员经过二次确认后修改自己由系统自动生成的账号 ID。

## 配置

编辑 `.env`：

```text
WECOM_CORP_ID=企业ID
WECOM_SECRET=自建应用Secret
WECOM_AGENT_ID=自建应用AgentId
WECOM_QR_ADMIN_USERID=zhengfei
WECOM_CONTACTS_SECRET=通讯录同步Secret
WECOM_CALLBACK_TOKEN=接收消息页面填写的Token
WECOM_CALLBACK_AES_KEY=接收消息页面生成的EncodingAESKey
ADMIN_PASSWORD=至少8位的管理员密码
```

企业微信应用后台“接收消息 → 设置 API 接收”：

```text
URL: https://你的已备案域名/wecom/callback
Token: 与 WECOM_CALLBACK_TOKEN 相同
EncodingAESKey: 与 WECOM_CALLBACK_AES_KEY 相同
```

服务支持企业微信的 URL 验证 GET 请求和加密消息 POST 请求。普通自建应用消息里的
`FromUserName` 会通过通讯录成员接口确认；智能机器人提供的 `open_userid` 会按文档
`101521` 调用 `batch/openuserid_to_userid` 转换成明文 `userid`。

## 修改账号 ID

普通自建应用没有通讯录编辑权限。要启用修改功能，企业超级管理员需在“管理工具 →
通讯录同步”中开启 API 接口编辑通讯录、配置服务器可信 IP，并将该处的 Secret 填入
`WECOM_CONTACTS_SECRET`。不要把自建应用 Secret 填到这个配置项。

成员只能修改自己的账号 ID，操作分为两步：

```text
修改ID new_userid
确认修改 123456
```

确认码有效期为 5 分钟。根据企业微信规则，只有系统自动生成的 `userid` 可以修改，且
仅允许修改一次；成功后不可撤销。服务不会使用消息命令修改其他成员的 ID。

## 微信插件关注二维码

公开首页会显示当前微信插件关注二维码。管理页面没有公开入口，地址为：

```text
https://你的已备案域名/admin
```

管理员必须先输入 `ADMIN_PASSWORD`，之后才能生成企业微信管理后台登录二维码。扫码并
确认后，管理 Cookie 仅保存在服务端，并使用管理员密码派生的 AES-256-GCM 密钥加密
写入 `data/wxplugin-state.json`。浏览器和公开接口都不会获得该 Cookie。

服务每小时检查一次二维码年龄，超过 6 天时尝试自动刷新。企业微信没有公开的
`wxPlugin` API，这里使用管理后台的未公开接口；接口变更或管理 Cookie 失效后，需要
重新进入 `/admin` 扫码登录。若企业微信要求手机二次验证，管理页会显示验证码输入框；
验证成功后才会保存正式 Cookie，不会保存临时或未完成验证的会话。

公开页面提供“提醒管理员更新二维码”按钮。提醒通过自建企业微信应用发送给
`WECOM_QR_ADMIN_USERID`，默认值为 `zhengfei`。应用 Secret、AgentId 和接收人均只在
服务端使用，不会返回到浏览器。为防止公开按钮被滥用，成功发送后 12 小时内不会重复
通知。

公开页面同时提供简易关注教程和企业微信官方“我的企业”入口示例图。教程素材来源：
https://open.work.weixin.qq.com/help2/pc/14799?person_id=1

## 部署

```bash
docker compose up -d --build
curl http://127.0.0.1:18081/health
```

Nginx 将备案域名反向代理到 `127.0.0.1:18081`。企业微信应用还必须拥有对应部门的
通讯录查看权限，服务器公网 IP 需要加入企业微信应用可信 IP。
