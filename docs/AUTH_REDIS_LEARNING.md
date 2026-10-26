# 新增改动学习指南：JWT 鉴权 + Redis 缓存（含面试知识）

> 本文件解释这次对项目新增的**两个后端能力**：登录鉴权（JWT）和缓存（Redis）。
> 每一处改动都标了对应的**面试题**，并给出**口述版答案**。目标是：最快看懂改动 + 面试能讲。

---

## 一、改动总览（改了哪些文件，为什么）

| 文件                                                                              | 作用                                     | 对应面试题                             |
| --------------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------- |
| `server/auth/password.ts`                                                         | scrypt 密码哈希 + 盐                     | "密码怎么存？为什么加盐？"             |
| `server/auth/jwt.ts`                                                              | HS256 JWT 签发/校验                      | "JWT 结构？无状态鉴权？"               |
| `server/auth/authRequired.ts`                                                     | 鉴权中间件                               | "中间件怎么校验 token？401 怎么返回？" |
| `server/auth/authService.ts`                                                      | 注册/登录/当前用户业务                   | "登录鉴权链路怎么走？"                 |
| `server/repositories/userRepo.ts`                                                 | users 表读写                             | "数据访问层怎么分层？"                 |
| `server/db/schema.sql` + `migrate.ts`(v3)                                         | users 表 + user_id 列                    | "数据库怎么加表/加字段？"              |
| `server/lib/cache.ts`                                                             | Redis 缓存（无 Redis 回退内存）          | "缓存穿透/击穿/雪崩怎么解决？"         |
| `server/index.ts`                                                                 | 加认证路由 + 保护知识库/chat 路由 + 缓存 | "怎么给接口加权限？怎么接入缓存？"     |
| `server/repositories/chunkRepo.ts` / `knowledgeBase.ts` / `mcp/knowledgeTools.ts` | 知识库按 user_id 隔离                    | "怎么实现私有数据隔离？"               |

---

## 二、必背：JWT 登录鉴权链路（面试最常问）

### 2.1 完整链路（能讲出来的版本）

> 前端把用户名密码 POST 到 `/api/auth/login` → 后端查 users 表、用 scrypt 校验密码哈希 → 校验通过后签发 JWT（包含 `sub=用户id`、`iat` 签发时间、`exp` 过期时间，用密钥 HMAC-SHA256 签名）→ 返回 `access_token` → 前端存 localStorage，之后每次请求在 `Authorization: Bearer <token>` 带上 → 后端 `authRequired` 中间件验签名和过期 → 通过就放行，把 `req.user` 挂上；失败返回 401。

### 2.2 为什么无状态（口述要点）

> JWT 服务端**不存会话**，靠签名验 token 真伪。好处是天然支持多台服务器/分布式、水平扩容无共享状态；代价是 token 一旦签发在过期前无法主动作废（所以过期时间要短，或用黑名单）。

### 2.3 面试高频追问

- **JWT 由哪几部分组成？** `header.payload.signature`，header 声明算法，payload 放业务声明（sub/iat/exp），signature 是 `HMAC(header.payload, 密钥)`。
- **为什么用 HMAC 而不是直接加密 payload？** 签名保证**防篡改**（payload 被改，签名对不上）；payload 本身 base64 可解，所以**不要放敏感信息**。
- **token 放哪？** 前端一般放 localStorage 或内存，Authorization 头携带；放 Cookie 要防 CSRF。
- **密码为什么不能明文/只用 MD5？** 要用带盐的慢哈希（scrypt/bcrypt/argon2），抗彩虹表和暴力破解；校验用 `timingSafeEqual` 防时序攻击。

---

## 三、必背：缓存三大问题（Redis 面试必考大题）

改动里用 `server/lib/cache.ts` 给「知识库列表」加了缓存（配了 `REDIS_URL` 走真实 Redis，没配回退进程内内存）。它演示的就是经典的 **Cache-Aside（旁路缓存）** 模式：

```
读：先查缓存 -> 命中直接返回；未命中查数据库 -> 写回缓存（带 TTL）
写：更新数据库后 -> 主动删除缓存（保证下次读到新的）
```

面试时用这个模式引出**缓存三大问题**（一定要能自然讲出）：

1. **缓存穿透**：查的 key 在缓存和数据库都不存在，每次都打到数据库。
   → 解决：对不存在的 key 也缓存空值（短 TTL）；布隆过滤器在缓存前拦截。
2. **缓存击穿**：某个**热点 key** 过期瞬间，大量请求同时打到数据库。
   → 解决：互斥锁（只让一个线程查库回填，其他等待）；热点 key 逻辑过期 + 后台异步更新。
3. **缓存雪崩**：**大量 key** 同时过期，或 Redis 宕机，请求全部打到数据库。
   → 解决：过期时间加**随机偏移**（本项目 60s 就是这么设计的思路）；多级缓存（本地 + Redis）；熔断降级；Redis 高可用集群。

**补充追问**：

- **缓存一致性怎么保证？** Cache-Aside：写库后删缓存；或用「先删缓存再写库 + 延迟双删」。强一致很难，业务上通常接受最终一致。
- **Redis 和进程内缓存区别？** Redis 是独立服务、多实例共享、可持久化；进程内缓存快但每台机器各一份、不共享、重启丢。

---

## 四、必背：私有数据隔离（你怎么实现"只看到自己的知识库"）

> 给 `documents` 表加 `user_id` 列；上传时写入当前用户 id；查询/删除时**按 user_id 过滤**。这样用户 A 看不到 B 的文档。加列用迁移（v3）实现，老数据 user_id 为 NULL 不受影响。

**追问**：如果某个接口漏传 user_id 会怎样？

> 我做了两层兜底：一是所有知识库路由都挂了 `authRequired`，能拿到 `req.user.userId`；二是仓储层 `getDocument(id, userId)` 里，如果文档的 user_id 不是当前用户，直接返回空（视为不存在），避免越权读。

---

## 五、怎么跑起来验证（本地）

```bash
# 1. 装依赖（已加 ioredis）
npm install

# 2. 建 .env.local，至少配：
#    JWT_SECRET=<一串随机字符串>   （鉴权必填，本地也可不配，用开发默认值）
#    QWEN_API_KEY=<你的key>        （原来就有）
#    REDIS_URL=                    （可选，不配就走内存缓存）

# 3. 迁移数据库（新增了 users 表和 user_id 列，必须跑一次）
npm run db:migrate

# 4. 启动
npm run dev
```

**用 curl 走一遍（面试前务必亲手跑一次）：**

```bash
# 注册 -> 登录拿 token
curl -X POST localhost:8788/api/auth/register -H 'Content-Type: application/json' \
  -d '{"username":"kangyue","password":"123456"}'
curl -X POST localhost:8788/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"kangyue","password":"123456"}'
# 用返回的 access_token：
curl localhost:8788/api/knowledge -H "Authorization: Bearer <token>"   # 正常返回
curl localhost:8788/api/knowledge                                        # 401
curl localhost:8788/api/auth/me -H "Authorization: Bearer <token>"      # 当前用户
```

**前端接入**：登录页调 `/api/auth/login` 拿 token 存起来，之后每个请求加 `Authorization: Bearer <token>` 头。本项目是 Vue，可以在请求封装里统一加（对应你以前做过的 axios/fetch 拦截器经验）。

---

## 六、30 秒面试陈述（把这次改动讲出去）

> "我给项目补了完整的用户体系：注册登录签发 JWT，密码用 scrypt 加盐哈希；知识库和对话接口都加了鉴权中间件，私有知识库按 user_id 隔离。缓存这块，我给热点接口（知识库列表）接了 Redis 缓存，用 Cache-Aside 模式，写操作主动失效缓存，并针对缓存穿透、击穿、雪崩做了兜底。"
> —— 一句话把"鉴权 + 隔离 + 缓存 + 一致性"全带出来，面试官一听就知道你懂全栈后端。

---

## 七、还可进一步做（有余力再补，别贪多）

- 会话（sessions）也按 user_id 隔离（现在只隔离了知识库文档）
- 登录失败次数限制 / token 黑名单（主动登出）
- 上传文件类型与大小限制更细的校验
- 把缓存从"知识库列表"扩展到会话热数据、检索热缓存
