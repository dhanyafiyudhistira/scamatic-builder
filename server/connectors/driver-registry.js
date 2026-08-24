import { ThingsBoardDriver } from './thingsboard-driver.js'

const factories = new Map([['thingsboard', options => new ThingsBoardDriver(options)]])

export function registerConnectorDriver(type, factory) {
  if (!type || typeof factory !== 'function') throw new TypeError('Driver registration requires a type and factory.')
  factories.set(type, factory)
}

export function createConnectorDriver(type, options) {
  const factory = factories.get(type)
  if (!factory) throw new Error(`Connector driver is not registered: ${type}.`)
  return factory(options)
}

export function registeredConnectorDrivers() { return [...factories.keys()] }
