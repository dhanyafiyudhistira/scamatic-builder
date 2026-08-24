export class AsyncQueue {
  #values = []
  #waiters = []
  #closed = false
  #error = null

  push(value) {
    if (this.#closed) return
    const waiter = this.#waiters.shift()
    if (waiter) waiter.resolve({ value, done: false })
    else this.#values.push(value)
  }

  close(error = null) {
    if (this.#closed) return
    this.#closed = true
    this.#error = error
    for (const waiter of this.#waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ value: undefined, done: true })
  }

  [Symbol.asyncIterator]() { return this }
  next() {
    if (this.#values.length) return Promise.resolve({ value: this.#values.shift(), done: false })
    if (this.#closed) return this.#error ? Promise.reject(this.#error) : Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }))
  }
}
