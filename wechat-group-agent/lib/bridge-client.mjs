/**
 * wx-bridge 的 WebSocket 客户端：连不上就退避重连，命令走 id 配对 Promise。
 * 用 Node 内置全局 WebSocket（Node 22+），插件零外部依赖。
 */
export class BridgeClient {
  /**
   * @param {object} o
   * @param {string} o.url ws://127.0.0.1:17300
   * @param {(evt:object)=>void} o.onEvent 事件（msg/login/sticker/error/ws-open/ws-close...）
   * @param {(line:string)=>void} [o.log]
   */
  constructor({ url, onEvent, log = () => {} }) {
    this.url = url
    this.onEvent = onEvent
    this.log = log
    this.ws = null
    this.connected = false
    this.closed = false
    this._seq = 0
    this._waiters = new Map()
    this._retry = 1500
    this._status = { connected: false, lastError: '', hello: null, reconnects: 0 }
  }

  get status() { return this._status }

  connect() {
    if (this.closed) return
    try {
      const ws = new WebSocket(this.url)
      this.ws = ws
      ws.addEventListener('open', () => {
        this.connected = true
        this._retry = 1500
        this._status.connected = true
        this._status.lastError = ''
        this.log('bridge 已连接 ' + this.url)
        // 自报身份：桥会踢掉同身份的旧连接（热重载残留的旧实例），
        // 否则两个实例同时收消息 → 群里会出现重复回答（踩过）
        try { ws.send(JSON.stringify({ id: 'identify-1', op: 'identify', name: 'dsh-wechat-bot', pid: process.pid })) } catch { /* ignore */ }
        this.onEvent({ t: 'ws-open' })
      })
      ws.addEventListener('message', (ev) => {
        let msg
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
        if (msg.t === 'reply') {
          const w = this._waiters.get(msg.id)
          if (w) {
            this._waiters.delete(msg.id)
            clearTimeout(w.timer)
            msg.ok ? w.resolve(msg.result) : w.reject(new Error(msg.error || '命令失败'))
          }
          return
        }
        if (msg.t === 'hello') this._status.hello = msg
        this.onEvent(msg)
      })
      ws.addEventListener('close', () => {
        this.connected = false
        this._status.connected = false
        this._failWaiters('bridge 连接已断开')
        if (this.closed) return
        this._status.reconnects += 1
        this.log(`bridge 断开，${Math.round(this._retry / 1000)}s 后重连`)
        this.onEvent({ t: 'ws-close' })
        setTimeout(() => this.connect(), this._retry)
        this._retry = Math.min(30_000, Math.round(this._retry * 1.7))
      })
      ws.addEventListener('error', (e) => {
        this._status.lastError = String(e?.message || 'ws error')
        // close 事件会紧随其后，这里只记录
      })
    } catch (e) {
      this._status.lastError = String(e?.message || e)
      this.log('bridge 连接失败：' + this._status.lastError)
      if (!this.closed) {
        setTimeout(() => this.connect(), this._retry)
        this._retry = Math.min(30_000, Math.round(this._retry * 1.7))
      }
    }
  }

  _failWaiters(reason) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer)
      w.reject(new Error(reason))
    }
    this._waiters.clear()
  }

  /** 发命令并等结果 */
  call(op, args = {}, timeoutMs = 20_000) {
    return new Promise((resolve, reject) => {
      if (!this.connected || this.ws?.readyState !== 1) {
        reject(new Error('bridge 未连接'))
        return
      }
      const id = 'c' + (++this._seq)
      const timer = setTimeout(() => {
        this._waiters.delete(id)
        reject(new Error(op + ' 超时'))
      }, timeoutMs)
      this._waiters.set(id, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, op, ...args }))
      } catch (e) {
        clearTimeout(timer)
        this._waiters.delete(id)
        reject(e)
      }
    })
  }

  /** 不等结果（失败只记日志） */
  fire(op, args = {}) {
    this.call(op, args).catch((e) => this.log(`${op} 失败：${e.message}`))
  }

  close() {
    this.closed = true
    this._failWaiters('插件已卸载')
    try { this.ws?.close() } catch { /* ignore */ }
    this.ws = null
  }
}
