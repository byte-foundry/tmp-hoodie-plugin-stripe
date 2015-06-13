'use strict';

var _slicedToArray = function (arr, i) { if (Array.isArray(arr)) { return arr; } else if (Symbol.iterator in Object(arr)) { var _arr = []; var _n = true; var _d = false; var _e = undefined; try { for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) { _arr.push(_s.value); if (i && _arr.length === i) break; } } catch (err) { _d = true; _e = err; } finally { try { if (!_n && _i['return']) _i['return'](); } finally { if (_d) throw _e; } } return _arr; } else { throw new TypeError('Invalid attempt to destructure non-iterable instance'); } };

var _classCallCheck = function (instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError('Cannot call a class as a function'); } };

var _createClass = (function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ('value' in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; })();

var _get = function get(object, property, receiver) { var desc = Object.getOwnPropertyDescriptor(object, property); if (desc === undefined) { var parent = Object.getPrototypeOf(object); if (parent === null) { return undefined; } else { return get(parent, property, receiver); } } else if ('value' in desc) { return desc.value; } else { var getter = desc.get; if (getter === undefined) { return undefined; } return getter.call(receiver); } };

var _inherits = function (subClass, superClass) { if (typeof superClass !== 'function' && superClass !== null) { throw new TypeError('Super expression must either be null or a function, not ' + typeof superClass); } subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, enumerable: false, writable: true, configurable: true } }); if (superClass) subClass.__proto__ = superClass; };

var util = require('util');
var stripe = require('stripe')('');
var Server = require('nexus-flux-socket.io/server');
var Client = require('nexus-flux/adapters/Local').Client;
var Remutable = require('remutable');
var uuid = require('node-uuid');
var CreateError = require('http-errors');
var _ = require('lodash');

// 30 min cleanup interval
var CLEANUP_INTERVAL = 1000 * 60 * 30;
// 8 hours peremption time for store
var TOO_LONG_SINCE_LAST_USE = 1000 * 60 * 60 * 8;

var StripeServer = (function (_Server) {
	function StripeServer() {
		_classCallCheck(this, StripeServer);

		_get(Object.getPrototypeOf(StripeServer.prototype), 'constructor', this).apply(this, arguments);
		this.aclTable = {};
		this._stores = {};
		this.lastCleanup = Date.now();
	}

	_inherits(StripeServer, _Server);

	_createClass(StripeServer, [{
		key: 'serveStore',
		value: function serveStore(_ref) {
			var _this = this;

			var path = _ref.path;

			return new Promise['try'](function () {
				var _path$split = path.split('$$');

				var _path$split2 = _slicedToArray(_path$split, 2);

				var junk = _path$split2[0];
				var hoodieId = _path$split2[1];

				if (!_.isString(path)) {
					throw CreateError(400, 'Path should be a string');
				}

				if (_this._stores[path] === undefined) {
					throw CreateError(404, 'Store not found');
				}
				if (_.indexOf(_this.aclTable[path], hoodieId) != -1) {
					return _this._stores[path].toJSON();
				} else {
					throw CreateError(401, 'not authorized');
				}
			});
		}
	}, {
		key: 'receiveFromLink',
		value: function receiveFromLink(linkId, ev) {
			if (ev instanceof Client.Event.Subscribe) {
				var _ev$path$split = ev.path.split('$$');

				var _ev$path$split2 = _slicedToArray(_ev$path$split, 2);

				var junk = _ev$path$split2[0];
				var hoodieId = _ev$path$split2[1];

				if (_.indexOf(this.aclTable[ev.path], hoodieId) != -1) {
					_get(Object.getPrototypeOf(StripeServer.prototype), 'receiveFromLink', this).call(this, linkId, ev);
				} else {
					var event = new Server.Delete(ev.path);
					this._links[linkId].sendToClient(event);
					this._links[linkId].lifespan.release();
				}
			} else if (ev instanceof Client.Event.Unsubscribe) {
				this.aclTable.splice(_.indexOf(this.aclTable[ev.path], ev.hoodieId), 1);
				_get(Object.getPrototypeOf(StripeServer.prototype), 'receiveFromLink', this).call(this, linkId, ev);
			} else {
				_get(Object.getPrototypeOf(StripeServer.prototype), 'receiveFromLink', this).call(this, linkId, ev);
			}
		}
	}, {
		key: 'createPrivateStore',
		value: function createPrivateStore(path, hoodieId) {
			var _this2 = this;

			var initValues = arguments[2] === undefined ? {} : arguments[2];

			if (!this.aclTable[path]) {
				this.aclTable[path] = [];
			}

			if (!this._stores[path]) {
				console.log('[createPrivateStore] Creating store : ' + path);
				this.aclTable[path].push(hoodieId);

				this._stores[path] = new Remutable(initValues);
				this._stores[path].lastUse = Date.now();
				this.lifespan.onRelease(function () {
					_this2.aclTable = null;
				});
			}

			if (Date.now() - this.lastCleanup > CLEANUP_INTERVAL) {
				_.each(this._stores, function (store, name) {
					if (Date.now() - store.lastUse > TOO_LONG_SINCE_LAST_USE) {
						delete _this2._stores[name];
						delete _this2.aclTable[name];
					}
				});
			}
		}
	}]);

	return StripeServer;
})(Server);

var storeServer = new StripeServer(43430);

module.exports = function (hoodie, doneCallback) {
	var router = {};

	hoodie.task.on('stripe:add', function (originDb, task) {
		if (!task._deleted) {
			var hoodieId = originDb.split('/')[1];
			var path = task.storeId;
			storeServer.createPrivateStore(path, hoodieId, {});

			hoodie.database(originDb).find('customer', 'id', function (err, doc) {
				if (!err) {
					stripe.customers.retrieve(doc.value, function (err, customer) {
						var patch = storeServer._stores[path].set('subscriptions', customer.subscriptions.data).set('cards', customer.sources.data).set('customerId', customer.id).commit();
						storeServer.dispatchUpdate(path, patch);
					});
				}
			});

			stripePluginCallback(undefined, originDb, task);
		}
	});

	hoodie.database('app').findAll(function (error, docs) {
		stripe.setApiKey(docs[0].config.stripe_key);
	});

	hoodie.account.findAll(function (error, accounts) {
		accounts.forEach(function (account) {
			hoodie.task.addSource('user/' + account.hoodieId);
		});
	});

	var stripePluginCallback = function stripePluginCallback(error, originDb, task) {
		if (error) {
			return hoodie.task.error(originDb, task, error);
		}

		return hoodie.task.success(originDb, task);
	};

	function sendError(path, error) {
		var patch = storeServer._stores[path].set('error', error).commit();
		storeServer.dispatchUpdate(path, patch);
	}

	function checkSubscription(planType, customerId) {
		return new Promise(function (resolve, reject) {
			stripe.customers.retrieve(customerId, function (err, customer) {
				if (err) {
					reject(err);
				} else if (customer.subscriptions.total_count > 0 && customer.subscriptions.data[0].plan.id == planType) {
					reject({ error: 'already subscribed to this plan' });
				} else {
					resolve(true);
				}
			});
		});
	}

	function stripeSub(options, customerId) {
		return new Promise(function (resolve, reject) {
			stripe.customers.createSubscription(customerId, options, function (err, subscription) {
				if (err) {
					reject(err);
				} else {
					resolve(subscription);
				}
			});
		});
	}

	var actions = {
		'/add-customer': function addCustomer(_ref2) {
			var path = _ref2.path;
			var hoodieId = _ref2.hoodieId;
			var token = _ref2.token;
			var email = _ref2.email;

			hoodie.database('user/' + hoodieId).find('customer', 'id', function (err, doc) {
				if (!err) {
					sendError(path, {
						status: 409,
						message: ' customer already exists'
					});
				} else {
					stripe.customers.create({
						source: token,
						email: email,
						metadata: {
							hoodieId: hoodieId }
					}, function (err, customer) {
						if (err) {
							sendError(path, err);
						} else {
							var patch = storeServer._stores[path].set('cards', customer.sources.data).commit();
							storeServer.dispatchUpdate(path, patch);

							hoodie.database('user/' + hoodieId).add('customer', { value: customer.id, id: 'id' }, function () {});
						}
					});
				}
			});
		},
		'/add-source': function addSource(_ref3) {
			var path = _ref3.path;
			var token = _ref3.token;
			var customerId = _ref3.customerId;

			stripe.customers.createSource(customerId, {
				source: token }, function (err, card) {
				if (err) {
					sendError(path, err);
				} else {
					var cards = storeServer._stores[path].get('cards');
					cards.push(card);
					var patch = storeServer._stores[path].set('cards', cards).commit();
					storeServer.dispatchUpdate(path, patch);
				}
			});
		},
		'/change-source': function changeSource(_ref4) {
			var path = _ref4.path;
			var token = _ref4.token;
			var customerId = _ref4.customerId;
			var cardId = _ref4.cardId;

			stripe.customers.createSource(customerId, {
				source: token }, function (err, card) {
				if (err) {
					sendError(path, err);
				} else {
					stripe.customers.deleteCard(customerId, cardId, function (err, confirmation) {
						if (err) {
							sendError(path, err);
						} else {
							var cards = storeServer._stores[path].get('cards');
							cards.splice(_.findIndex(cards, function (card) {
								return card.id = confirmation.id;
							}), 1);
							cards.push(card);
							var patch = storeServer._stores[path].set('cards', cards).commit();
							storeServer.dispatchUpdate(path, patch);
						}
					});
				}
			});
		},
		'/remove-source': function removeSource(_ref5) {
			var path = _ref5.path;
			var cardId = _ref5.cardId;
			var customerId = _ref5.customerId;

			stripe.customers.retrieve(customerId, function (err, customer) {
				if (customer.subscriptions.total_count > 0 && customer.sources.total_count == 1) {
					sendError(path, {
						status: 400,
						message: 'You still have a subscription you cannot remove your last source' });
				} else {
					stripe.customers.deleteCard(customerId, cardId, function (err, confirmation) {
						var cards = storeServer._stores[path].get('cards');
						cards.splice(_.findIndex(cards, function (card) {
							return card.id = confirmation.id;
						}), 1);
						var patch = storeServer._stores[path].set('cards', cards).commit();
						storeServer.dispatchUpdate(path, patch);
					});
				}
			});
		},
		'/add-subscription': function addSubscription(_ref6) {
			var path = _ref6.path;
			var customerId = _ref6.customerId;
			var planType = _ref6.planType;
		},
		'/coupon-sub': function couponSub(_ref7) {
			var path = _ref7.path;
			var customerId = _ref7.customerId;
			var coupon = _ref7.coupon;

			var plan = 'premium_plan';
			checkSubscription(plan, customerId).then(function (result) {
				return stripeSub({
					plan: plan,
					coupon: coupon }, customerId);
			}).then(function (subscription) {
				var sub = storeServer._stores[path].get('subscriptions');
				sub.push(subscription);
				var patch = storeServer._stores[path].set('subscriptions', sub).commit();
				storeServer.dispatchUpdate(path, patch);
			})['catch'](function (err) {
				sendError(path, err);
			});
		},
		'/pwyw-subscription': function pwywSubscription(_ref8) {
			var path = _ref8.path;
			var customerId = _ref8.customerId;
			var amount = _ref8.amount;

			var plan = 'pwyw_plan';
			if (amount > 1) {
				checkSubscription(plan, customerId).then(function (result) {
					return new Promise(function (resolve, reject) {
						stripe.charges.create({
							amount: amount * 100,
							customer: customerId,
							currency: 'usd' }, function (err, charge) {
							if (err) {
								reject(err);
							} else {
								resolve(charge);
							}
						});
					});
				}).then(function (charge) {
					return stripeSub({
						plan: plan }, customerId);
				}).then(function (subscription) {
					var sub = storeServer._stores[path].get('subscriptions');
					sub.push(subscription);
					var patch = storeServer._stores[path].set('subscriptions', sub).commit();
					storeServer.dispatchUpdate(path, patch);
				})['catch'](function (err) {
					sendError(path, err);
				});
			} else {
				sendError(path, {
					status: 400,
					error: 'amount is under 1$'
				});
			}
		},
		'/remove-subscription': function removeSubscription(_ref9) {
			var path = _ref9.path;
			var subscriptionId = _ref9.subscriptionId;
			var customerId = _ref9.customerId;
			var end = _ref9.end;

			stripe.customers.cancelSubscription(customerId, subscriptionId, { at_period_end: end }, function (err, confirmation) {
				if (err) {
					sendError(path, {
						status: 400,
						message: err.message });
				}
				var subscriptions = storeServer._stores[path].get('subscriptions');
				subscriptions.splice(_.findIndex(subscriptions, function (sub) {
					return sub.id = confirmation.id;
				}), 1);
				var patch = storeServer._stores[path].set('subscriptions', subscriptions).commit();
				storeServer.dispatchUpdate(path, patch);
			});
		} };

	storeServer.on('action', function (_ref10) {
		var path = _ref10.path;
		var params = _ref10.params;

		if (actions[path] !== undefined) {
			actions[path](params);
		}
	}, storeServer.lifespan);

	doneCallback();
};
