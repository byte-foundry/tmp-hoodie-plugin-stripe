var util = require('util');
var stripe = require('stripe')('');
var Server = require('nexus-flux-socket.io/server');
var Client = require('nexus-flux/adapters/Local').Client;
var Remutable = require('remutable');
var uuid = require('node-uuid');
var CreateError = require('http-errors');
var _ = require('lodash');

// 30 min cleanup interval
var CLEANUP_INTERVAL = 1000*60*30;
// 8 hours peremption time for store
var TOO_LONG_SINCE_LAST_USE = 1000*60*60*8;

class StripeServer extends Server {
	constructor() {
		super(...arguments);
		this.aclTable = {};
		this._stores = {};
		this.lastCleanup = Date.now();
	}

	serveStore({path}) {

		return new Promise.try(() => {
			var [junk,hoodieId] = path.split('$$');
			if (!_.isString(path)) {
				throw CreateError(400, 'Path should be a string');
			}

			if (this._stores[path] === undefined) {
				throw CreateError(404, 'Store not found');
			}
			if (_.indexOf(this.aclTable[path], hoodieId) != -1) {
				return this._stores[path].toJSON();
			}
			else {
				throw CreateError(401, 'not authorized');
			}
		});

	}

	receiveFromLink(linkId, ev) {
		if (ev instanceof Client.Event.Subscribe) {
			var [junk,hoodieId] = ev.path.split('$$');
			if (_.indexOf(this.aclTable[ev.path], hoodieId) != -1) {
				super.receiveFromLink(linkId,ev);
			}
			else {
				var event = new Server.Delete(ev.path);
				this._links[linkId].sendToClient(event);
				this._links[linkId].lifespan.release();
			}
		} 
		else if (ev instanceof Client.Event.Unsubscribe) {
			this.aclTable.splice(_.indexOf(this.aclTable[ev.path], ev.hoodieId), 1);
			super.receiveFromLink(linkId, ev);
		}
		else {
			super.receiveFromLink(linkId, ev);
		}
	}

	createPrivateStore(path, hoodieId, initValues = {}) {
		if (!this.aclTable[path]) {
			this.aclTable[path] = [];
		}

		if (!this._stores[path]) {
			console.log('[createPrivateStore] Creating store : ' + path);
			this.aclTable[path].push(hoodieId);

			this._stores[path] = new Remutable(initValues)
			this._stores[path].lastUse = Date.now();
			this.lifespan.onRelease(() => {
				this.aclTable = null;
			});
		}

		if (Date.now() - this.lastCleanup > CLEANUP_INTERVAL) {
			_.each(this._stores, (store, name) => {
				if (Date.now() - store.lastUse > TOO_LONG_SINCE_LAST_USE) {
					delete this._stores[name];
					delete this.aclTable[name];
				}
			});
		}
	}
}

var storeServer = new StripeServer(43430);


module.exports = function(hoodie, doneCallback) {
	var router = {};

	hoodie.task.on('stripe:add', function(originDb, task) {
		if (!task._deleted) {
			var hoodieId = originDb.split('/')[1];
			var path = task.storeId;
			storeServer.createPrivateStore(path,hoodieId,{});

			hoodie.database(originDb).find('customer', 'id', function(err, doc) {
				if (!err) {
					stripe.customers.retrieve(doc.value, function(err, customer) {
						const patch = storeServer._stores[path]
							.set('subscriptions',customer.subscriptions.data)
							.set('cards',customer.sources.data)
							.set('customerId', customer.id)
							.commit();
						storeServer.dispatchUpdate(path,patch);
					});
				}
			});

			stripePluginCallback(undefined, originDb, task);
		}
	});

	hoodie.database('app').findAll(function(error, docs) {
		stripe.setApiKey(docs[0].config.stripe_key);
	});

	hoodie.account.findAll(function(error, accounts) {
		accounts.forEach(function(account) {
			hoodie.task.addSource('user/' + account.hoodieId);
		})
	});

	var stripePluginCallback = function(error, originDb, task) {
		if ( error ) {
			return hoodie.task.error(originDb, task, error);
		}

		return hoodie.task.success(originDb, task);
	};

	function sendError(path, error) {
		const patch = storeServer._stores[path].set('error',error).commit();
		storeServer.dispatchUpdate(path, patch);
	}

	function checkSubscription(planType, customerId) {
		return new Promise((resolve, reject) => {
			stripe.customers.retrieve(customerId, (err, customer) => {
				if (err) {
					reject(err);
				}
				else if (customer.subscriptions.total_count > 0 &&
					customer.subscriptions.data[0].plan.id == planType) {
					reject({error: 'already subscribed to this plan'});
				}
				else {
					resolve(true);
				}
			});
		});
	}

	function stripeSub(options, customerId) {
		return new Promise((resolve, reject) => {
			stripe.customers.createSubscription(
				customerId,
				options,
				(err, subscription) => {
					if (err) {
						reject(err);
					}
					else {
						resolve(subscription);
					}
				}
			);
		})
	}

	const actions = {
		'/add-customer': ({path, hoodieId, token, email}) => {
			hoodie.database('user/' + hoodieId).find('customer','id',(err,doc) => {
				if (!err) {
					sendError(path,{
						status: 409,
						message: ' customer already exists'
					});
				}
				else {
					stripe.customers.create({
						source:token,
						email:email,
						metadata: {
							hoodieId: hoodieId,
						}
					}, function(err, customer) {
						if (err) {
							sendError(path,err);
						}
						else {
							const patch = storeServer._stores[path].set('cards',customer.sources.data).commit();
							storeServer.dispatchUpdate(path,patch);

							hoodie.database('user/' + hoodieId).add('customer',{value:customer.id,id:'id'},() => {});
						}
					})
				}
			});
		},
		'/add-source': ({path, token, customerId}) => {
			stripe.customers.createSource(customerId,{
				source:token,
			}, (err, card) => {
				if (err) {
					sendError(path, err);
				}
				else {
					const cards = storeServer._stores[path].get('cards');
					cards.push(card);
					const patch = storeServer._stores[path].set('cards',cards).commit();
					storeServer.dispatchUpdate(path,patch);
				}
			});
		},
		'/change-source': ({path, token, customerId, cardId}) => {
			stripe.customers.createSource(customerId,{
				source:token,
			}, (err, card) => {
				if (err) {
					sendError(path,err);
				}
				else {
					stripe.customers.deleteCard(customerId, cardId, (err, confirmation) => {
						if (err) {
							sendError(path,err);
						}
						else {
							const cards = storeServer._stores[path].get('cards');
							cards.splice(_.findIndex(cards, (card) => { return card.id = confirmation.id}),1);
							cards.push(card);
							const patch = storeServer._stores[path].set('cards',cards).commit();
							storeServer.dispatchUpdate(path, patch);
						}
					});
				}
			})
		},
		'/remove-source': ({path, cardId, customerId}) => {
			stripe.customers.retrieve(customerId, (err, customer) => {
				if (customer.subscriptions.total_count > 0
					&& customer.sources.total_count == 1) {
					sendError(path, {
						status: 400,
						message: 'You still have a subscription you cannot remove your last source',
					})
				}
				else {
					stripe.customers.deleteCard(customerId, cardId, (err, confirmation) => {
						const cards = storeServer._stores[path].get('cards');
						cards.splice(_.findIndex(cards, (card) => { return card.id = confirmation.id}),1);
						const patch = storeServer._stores[path].set('cards',cards).commit();
						storeServer.dispatchUpdate(path, patch);
					});
				}
			})
		},
		'/add-subscription': ({path, customerId, planType}) => {
		},
		'/coupon-sub': ({path,customerId,coupon}) => {
			const plan = 'premium_plan';
			checkSubscription(plan,customerId)
				.then((result) => {
					return stripeSub({
						plan,
						coupon,
					},customerId);
				})
				.then((subscription) => {
					const sub = storeServer._stores[path].get('subscriptions');
					sub.push(subscription);
					const patch = storeServer._stores[path].set('subscriptions',sub).commit();
					storeServer.dispatchUpdate(path, patch);
				})
				.catch((err) => {
					sendError(path,err);
				});
		},
		'/pwyw-subscription': ({path, customerId, amount}) => {
			const plan = 'pwyw_plan';
			if (amount > 1) {
				checkSubscription(plan, customerId)
					.then((result) => {
						return new Promise((resolve, reject) => {
							stripe.charges.create({
								amount:amount*100,
								customer:customerId,
								currency:'usd',
							},(err, charge) => {
								if (err) {
									reject(err);
								}
								else {
									resolve(charge);
								}
							});
						});
					})
					.then((charge) => {
						return stripeSub({
							plan,
						}, customerId);
					})
					.then((subscription) => {
						const sub = storeServer._stores[path].get('subscriptions');
						sub.push(subscription);
						const patch = storeServer._stores[path].set('subscriptions',sub).commit();
						storeServer.dispatchUpdate(path, patch);
					})
					.catch((err) => {
						sendError(path,err);
					});
			}
			else {
				sendError(path, {
					status: 400,
					error:'amount is under 1$'
				});
			}
		},
		'/remove-subscription': ({path, subscriptionId, customerId,end}) => {
			stripe.customers.cancelSubscription(customerId, subscriptionId,{'at_period_end':end}, (err, confirmation) => {
				if (err) {
					sendError(path,{
						status: 400,
						message: err.message,
					})
				}
				const subscriptions = storeServer._stores[path].get('subscriptions');
				subscriptions.splice(_.findIndex(subscriptions, (sub) => { return sub.id = confirmation.id}),1);
				const patch = storeServer._stores[path].set('subscriptions',subscriptions).commit();
				storeServer.dispatchUpdate(path, patch);
			})
		},
	};

	storeServer.on('action',({path, params}) => {
		if (actions[path] !== undefined) {
			actions[path](params);
		}
	},storeServer.lifespan);

	doneCallback();
};