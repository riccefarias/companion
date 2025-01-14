/*
 * This file is part of the Companion project
 * Copyright (c) 2018 Bitfocus AS
 * Authors: William Viker <william@bitfocus.io>, Håkon Nessjøen <haakon@bitfocus.io>
 *
 * This program is free software.
 * You should have received a copy of the MIT licence as well as the Bitfocus
 * Individual Contributor License Agreement for companion along with
 * this program.
 *
 * You can be released from the requirements of the license by purchasing
 * a commercial license. Buying such a license is mandatory as soon as you
 * develop commercial activities involving the Companion software without
 * disclosing the source code of your own applications.
 *
 */

import { nanoid } from 'nanoid'
import { sleep } from '../Resources/Util.js'
import CoreBase from '../Core/Base.js'
import InstanceDefinitions from './Definitions.js'
import InstanceVariable from './Variable.js'
import ModuleHost, { ConnectionDebugLogRoom } from './Host.js'
import InstanceStatus from './Status.js'
import { cloneDeep } from 'lodash-es'
import jsonPatch from 'fast-json-patch'
import { isLabelValid, makeLabelSafe } from '../Shared/Label.js'
import InstanceModules from './Modules.js'

const InstancesRoom = 'instances'

class Instance extends CoreBase {
	#lastClientJson = null

	constructor(registry) {
		super(registry, 'instance', 'Instance/Controller')

		this.variable = new InstanceVariable(registry)
		this.definitions = new InstanceDefinitions(registry)
		this.status = new InstanceStatus(registry)
		this.moduleHost = new ModuleHost(registry, this.status)
		this.modules = new InstanceModules(registry)

		this.store = {
			db: {},
		}

		this.store.db = this.db.getKey('instance', {})

		// Prepare for clients already
		this.commitChanges()
	}

	getAllInstanceIds() {
		return Object.keys(this.store.db)
	}

	/**
	 * Handle an electron power event
	 * @param {string} event
	 */
	powerStatusChange(event) {
		if (event == 'resume') {
			this.logger.info('Power: Resuming')

			for (const id in this.store.db) {
				this.activate_module(id)
			}
		} else if (event == 'suspend') {
			this.logger.info('Power: Suspending')

			this.moduleHost.queueStopAllConnections().catch((e) => {
				this.logger.debug(`Error suspending instances: ${e?.message ?? e}`)
			})
		}
	}

	/**
	 * Initialise instances
	 * @param {string} extraModulePath - extra directory to search for modules
	 */
	async initInstances(extraModulePath) {
		this.logger.silly('instance_init', this.store.db)

		await this.modules.initInstances(extraModulePath)

		for (const id in this.store.db) {
			this.activate_module(id, false)
		}
	}

	reloadUsesOfModule(module_id) {
		// restart usages of this module
		let reloadLabels = []
		for (const [id, instance_config] of Object.entries(this.store.db)) {
			if (instance_config.instance_type === module_id && instance_config.enabled) {
				reloadLabels.push(instance_config.label)
				// Restart it
				this.enableDisableInstance(id, false)
				this.enableDisableInstance(id, true)
			}
		}

		this.logger.info(`Reloading ${reloadLabels.length} connections: ${reloadLabels.join(', ')}`)
	}

	setInstanceLabelAndConfig(id, newLabel, config, skip_notify_instance) {
		const entry = this.store.db[id]
		if (!entry) {
			this.logger.warn(`setInstanceLabelAndConfig id "${id}" does not exist!`)
			return
		}

		// Mark as definitely been initialised
		entry.isFirstInit = false

		// Update the config blob
		if (config) {
			entry.config = config
		}

		// Rename variables
		if (newLabel && entry.label != newLabel) {
			const oldLabel = entry.label
			entry.label = newLabel
			this.variable.instanceLabelRename(oldLabel, newLabel)
			this.definitions.updateVariablePrefixesForLabel(id, newLabel)
		}

		this.commitChanges()

		const instance = this.instance.moduleHost.getChild(id, true)
		if (newLabel) {
			this.instance.moduleHost.updateChildLabel(id, newLabel)
		}

		const updateInstance = !!newLabel || (config && !skip_notify_instance)
		if (updateInstance && instance) {
			instance.updateConfigAndLabel(entry.config, entry.label).catch((e) => {
				instance.logger.warn('Error updating instance configuration: ' + e.message)
			})
		}

		this.logger.debug(`instance "${entry.label}" configuration updated`)
	}

	makeLabelUnique(prefix, ignoreId) {
		const knownLabels = new Set()
		for (const [id, obj] of Object.entries(this.store.db)) {
			if (id !== ignoreId && obj && obj.label) {
				knownLabels.add(obj.label)
			}
		}

		prefix = makeLabelSafe(prefix)

		let label = prefix
		let i = 1
		while (knownLabels.has(label)) {
			// Try the next
			label = `${prefix}_${++i}`
		}

		return label
	}

	addInstance(data, disabled) {
		let module = data.type
		let product = data.product

		// Find the highest rank given to an instance
		const highestRank =
			Math.max(
				0,
				...Object.values(this.store.db)
					.map((c) => c.sortOrder)
					.filter((n) => typeof n === 'number')
			) || 0

		const moduleInfo = this.modules.known_modules[module]
		if (moduleInfo) {
			let id = nanoid()

			this.logger.info('Adding connection ' + module + ' ' + product)

			this.store.db[id] = {
				instance_type: module,
				sortOrder: highestRank + 1,
				label: this.makeLabelUnique(moduleInfo.display.shortname),
				isFirstInit: true,
				config: {
					product: product,
				},
			}

			if (disabled) {
				this.store.db[id].enabled = false
			}

			this.activate_module(id, true)

			this.logger.silly('instance_add', id)
			this.commitChanges()

			return id
		}
	}

	getLabelForInstance(id) {
		return this.store.db[id]?.label
	}

	getIdForLabel(label) {
		for (const [id, conf] of Object.entries(this.store.db)) {
			if (conf && conf.label === label) {
				return id
			}
		}
		return undefined
	}

	enableDisableInstance(id, state) {
		if (this.store.db[id]) {
			const label = this.store.db[id].label
			if (this.store.db[id].enabled !== state) {
				this.logger.info((state ? 'Enable' : 'Disable') + ' instance ' + label)
				this.store.db[id].enabled = state

				if (state === false) {
					this.moduleHost
						.queueStopConnection(id)
						.catch((e) => {
							this.logger.warn(`Error disabling instance ${label}: ` + e)
						})
						.then(() => {
							this.status.updateInstanceStatus(id, null, 'Disabled')

							this.definitions.forgetInstance(id)
							this.variable.forgetInstance(id, label)
							this.controls.clearInstanceState(id)
						})
				} else {
					this.status.updateInstanceStatus(id, null, 'Starting')
					this.activate_module(id)
				}

				this.commitChanges()
			} else {
				if (state === true) {
					this.logger.warn(`Attempting to enable connection "${label}" that is already enabled`)
				} else {
					this.logger.warn(`Attempting to disable connection "${label}" that is already disabled`)
				}
			}
		}
	}

	async deleteInstance(id) {
		const label = this.store.db[id]?.label
		this.logger.info(`Deleting instance: ${label ?? id}`)

		try {
			await this.moduleHost.queueStopConnection(id)
		} catch (e) {
			this.logger.debug(`Error while deleting instance "${label ?? id}": `, e)
		}

		this.status.forgetInstanceStatus(id)
		delete this.store.db[id]

		this.commitChanges()

		// forward cleanup elsewhere
		this.definitions.forgetInstance(id)
		this.variable.forgetInstance(id, label)
		this.controls.forgetInstance(id)
	}

	async deleteAllInstances() {
		const ps = []
		for (const instanceId of Object.keys(this.store.db)) {
			ps.push(this.deleteInstance(instanceId))
		}

		await Promise.all(ps)
	}

	/**
	 * Get information for the metrics system about the current instances
	 */
	getInstancesMetrics() {
		const instancesCounts = {}

		for (const instance_config of Object.values(this.store.db)) {
			if (instance_config.instance_type !== 'bitfocus-companion' && instance_config.enabled !== false) {
				if (instancesCounts[instance_config.instance_type]) {
					instancesCounts[instance_config.instance_type]++
				} else {
					instancesCounts[instance_config.instance_type] = 1
				}
			}
		}

		return instancesCounts
	}

	/**
	 * Stop/destroy all running instances
	 */
	async destroyAllInstances() {
		return this.moduleHost.queueStopAllConnections()
	}

	/**
	 * Save the instances config to the db, and inform clients
	 * @access protected
	 */
	commitChanges() {
		this.db.setKey('instance', this.store.db)

		const newJson = cloneDeep(this.getClientJson())

		// Now broadcast to any interested clients
		if (this.io.countRoomMembers(InstancesRoom) > 0) {
			const patch = jsonPatch.compare(this.#lastClientJson || {}, newJson || {})
			if (patch.length > 0) {
				this.io.emitToRoom(InstancesRoom, `instances:patch`, patch)
			}
		}

		this.#lastClientJson = newJson
	}

	exportInstance(instanceId, minimal = false, clone = true) {
		const rawObj = this.store.db[instanceId]
		const obj = minimal
			? {
					instance_type: rawObj.instance_type,
					label: rawObj.label,
					lastUpgradeIndex: rawObj.lastUpgradeIndex,
			  }
			: {
					...rawObj,
			  }
		delete obj.sortOrder

		return clone ? cloneDeep(obj) : obj
	}
	exportAll(clone = true) {
		const obj = this.store.db
		return clone ? cloneDeep(obj) : obj
	}

	/**
	 * Get the status of an instance
	 * @param {String} instance_id
	 * @returns {number} ??
	 */
	getInstanceStatus(instance_id) {
		return this.status.getInstanceStatus(instance_id)
	}

	/**
	 * Get the config object of an instance
	 * @param {String} instance_id
	 * @returns {Object} ??
	 */
	getInstanceConfig(instance_id) {
		return this.store.db[instance_id]
	}

	/**
	 * Start an instance running
	 * @param {string} id
	 * @param {boolean} is_being_created
	 */
	activate_module(id, is_being_created) {
		const config = this.store.db[id]
		if (!config) throw new Error('Cannot activate unknown module')

		config.instance_type = this.modules.verifyInstanceTypeIsCurrent(config.instance_type)

		if (config.enabled === false) {
			this.logger.silly("Won't load disabled module " + id + ' (' + config.instance_type + ')')
			return
		}

		// Ensure that the label is valid according to the new rules
		// This is excessive to do at every activation, but it needs to be done once everything is loaded, not when upgrades are run
		const safeLabel = makeLabelSafe(config.label)
		if (!is_being_created && safeLabel !== config.label) {
			this.setInstanceLabelAndConfig(id, safeLabel, null, true)
		}

		const moduleInfo = this.modules.known_modules[config.instance_type]
		if (!moduleInfo) {
			this.logger.error('Configured instance ' + config.instance_type + ' could not be loaded, unknown module')
		} else {
			this.moduleHost.queueRestartConnection(id, config, moduleInfo).catch((e) => {
				this.logger.error('Configured instance ' + config.instance_type + ' failed to start: ', e)
			})
		}
	}

	/**
	 * Setup a new socket client's events
	 * @param {SocketIO} client - the client socket
	 * @access public
	 */
	clientConnect(client) {
		this.variable.clientConnect(client)
		this.definitions.clientConnect(client)
		this.status.clientConnect(client)
		this.modules.clientConnect(client)

		client.onPromise('instances:subscribe', () => {
			client.join(InstancesRoom)

			return this.#lastClientJson || this.getClientJson()
		})
		client.onPromise('instances:unsubscribe', () => {
			client.leave(InstancesRoom)
		})

		client.onPromise('instances:edit', async (id) => {
			let instance = this.instance.moduleHost.getChild(id)

			if (!instance) {
				// Maybe instance has just been created and isn't yet ready

				// Wait a second then try again
				await sleep(1000)

				instance = this.instance.moduleHost.getChild(id)
			}

			if (instance) {
				try {
					const fields = await instance.requestConfigFields()

					const instanceConf = this.store.db[id]

					return {
						fields,
						label: instanceConf?.label,
						config: instanceConf?.config,
						instance_type: instanceConf?.instance_type,
					}
				} catch (e) {
					this.logger.silly(`Failed to load instance config_fields: ${e.message}`)
					return null
				}
			} else {
				// Unknown instance
				return null
			}
		})

		client.onPromise('instances:set-config', (id, label, config) => {
			const idUsingLabel = this.getIdForLabel(label)
			if (idUsingLabel && idUsingLabel !== id) {
				return 'duplicate label'
			}

			if (!isLabelValid(label)) {
				return 'invalid label'
			}

			this.setInstanceLabelAndConfig(id, label, config)

			return null
		})

		client.onPromise('instances:set-enabled', (id, state) => {
			this.enableDisableInstance(id, !!state)
		})

		client.onPromise('instances:delete', async (id) => {
			await this.deleteInstance(id)
		})

		client.onPromise('instances:add', (module) => {
			const id = this.addInstance(module, false)
			return id
		})

		client.onPromise('instances:set-order', async (instanceIds) => {
			if (!Array.isArray(instanceIds)) throw new Error('Expected array of ids')

			// This is a bit naive, but should be sufficient if the client behaves

			// Update the order based on the ids provided
			instanceIds.forEach((id, index) => {
				const entry = this.store.db[id]
				if (entry) entry.sortOrder = index
			})

			// Make sure all not provided are at the end in their original order
			const allKnownIds = Object.entries(this.store.db)
				.sort(([, a], [, b]) => a.sortOrder - b.sortOrder)
				.map(([id]) => id)
			let nextIndex = instanceIds.length
			for (const id of allKnownIds) {
				if (!instanceIds.includes(id)) {
					const entry = this.store.db[id]
					if (entry) entry.sortOrder = nextIndex++
				}
			}

			this.commitChanges()
		})

		client.onPromise('connection-debug:subscribe', (connectionId) => {
			if (!this.store.db[connectionId]) return false

			client.join(ConnectionDebugLogRoom(connectionId))

			return true
		})

		client.onPromise('connection-debug:unsubscribe', (connectionId) => {
			client.leave(ConnectionDebugLogRoom(connectionId))
		})
	}

	getClientJson() {
		const result = {}

		for (const [id, config] of Object.entries(this.store.db)) {
			result[id] = {
				instance_type: config.instance_type,
				label: config.label,
				enabled: config.enabled,
				sortOrder: config.sortOrder,

				// Runtime properties
				hasRecordActionsHandler: false,
			}

			const instance = this.moduleHost.getChild(id)
			if (instance) {
				result[id].hasRecordActionsHandler = instance.hasRecordActionsHandler
			}
		}

		return result
	}
}

export default Instance
