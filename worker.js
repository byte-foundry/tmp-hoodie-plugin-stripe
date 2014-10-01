var util = require('util');
var stripe = require('stripe')('');

module.exports = function(hoodie, doneCallback) {
	var router = {};
	hoodie.task.on('stripe:add', function(originDb, task) {
		router[task.subtype](originDb, task);
	});

	hoodie.database('app').findAll(function(error, docs) {
		stripe = require('stripe')(docs[0].config.stripeKey);
	});

	router['charges.create'] = function handleChargesCreate(originDb, task) {
		var ch = {
			card : task.card,
			amount : task.amount,
			currency : task.currency,
			description : task.username

		};

		stripe.charges.create(ch, function(error, charge) {
			if (error) {
					console.log(error);
			}
			var update = {
					stripeChargeId: charge.id

			};
			hoodie.account.update('user', task.username, update, function(error) {
				hoodie.database(originDb).add('stripe/charge', {
					id: task.chargeId,
					charge: charge

					}, function(error) {
							stripePluginCallback(error, originDb, task);
				});
			});
		});
	};

	router['charges.retrieve'] = function handleChargesRetrieve(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}
			hoodie.database(originDb).find('stripe/charge', task.chargeId, function(error, charge) {
				if (task.fromStripe) {
					stripe.charges.retrieve(charge.charge.id, function(error, charge) {
						stripePluginCallback(error, originDb, task);
					});

				} else {
					stripePluginCallback(error, originDb, task);
				}
			});
		});
	};

	router['charges.update'] = function handleChargesUpdate(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}

			hoodie.database(originDb).find('stripe/charge', task.chargeId, function(error, charge) {
				stripe.charges.update(charge.charge.id, {
					description: task.desc

					}, function(error, charge) {
						hoodie.database(originDb).update('stripe/charge', task.chargeId, {
							charge: charge

							}, function(error) {
								stripePluginCallback(error, originDb, task);
						});
				});
			});
		});
	};

	router['charges.list'] = function handleChargesList(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}

			hoodie.database(originDb).find('stripe/charge', task.chargeId, function(error, charge) {
				if (task.fromStripe) {
					stripe.charges.list({ limit: 5 }, function(err, charges) {
						stripePluginCallback(error, originDb, task);
					});

				} else {
					stripePluginCallback(error, originDb, task);
				}
			});
		});
	};

	router['customers.create'] = function handleCustomersCreate(originDb, task) {
		 var customer = {
			card: task.card

		};

		if (task.plan) {
			customer.plan = task.plan;
		}

		stripe.customers.create(customer, function(error, response) {
			if (error) {
					console.log(error);
			}
			var update = {
				stripeCustomerId: response.id

			};

			hoodie.account.update('user', task.username, update, function(error) {
				if (error) {
					console.log(error);
				}

				if (task.plan) {
					update.plan = task.plan;
					hoodie.database(originDb).add('stripe/subscription', {
						id: task.subscriptionId

						}, function(error) {
							console.log(error);
							stripePluginCallback(error, originDb, task);
					});

				} else {
					stripePluginCallback(error, originDb, task);
				}
			});
		});
	};

	router['customers.createSubscription'] = function handleCustomersCreateSubscription(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}

			stripe.customers.createSubscription(user.stripeCustomerId, {
				plan: task.plan

				}, function(err, subscription) {
					hoodie.database(originDb).add('stripe/subscription', {
						id: task.subscriptionId,
						subscription: subscription

					}, function(error) {
						stripePluginCallback(error, originDb, task);
					});
				});
		});
	}

	router['customers.retrieveSubscription'] = function handleCustomersRetrieveSubscription(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}

			hoodie.database(originDb).find('stripe/subscription', task.subscriptionId, function(error, subscription) {
				if (task.fromStripe) {
					stripe.customers.retrieveSubscription(user.stripeCustomerId, subscription.subscription.id, function(error, subscription) {
						stripePluginCallback(error, originDb, task);
					});

				} else {
					stripePluginCallback(error, originDb, task);
				}
			});
		});
	};

	router['customers.cancelSubscription'] = function handleCustomersCancelSubscription(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}

			hoodie.database(originDb).find('stripe/subscription', task.subscriptionId, function(error, subscription) {
				if (error) {
					console.log(error);
				}

				stripe.customers.cancelSubscription(user.stripeCustomerId, subscription.subscription.id, {
					at_period_end: true
					}, function(error, subscription) {
							if (error) {
								console.log(error);
							}

						hoodie.database(originDb).update('stripe/subscription', task.subscriptionId, {
							id: task.subscriptionId,
							subscription: subscription

						}, function(error) {
							stripePluginCallback(error, originDb, task);
						});
				});
			});
		});
	};

	router['customers.updateSubscription'] = function handleCustomersUpdateSubscription(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
				console.log(error);
			}

			hoodie.database(originDb).find('stripe/subscription', task.subscriptionId, function(error, subscription) {
				if (error) {
					console.log(error);
				}

				stripe.customers.updateSubscription(user.stripeCustomerId, subscription.subscription.id, {
					plan: task.plan

				}, function(error, subscription) {
					if (error) {
						console.log(error);
					}

					hoodie.database(originDb).update('stripe/subscription', task.subscriptionId, {
						id: task.subscriptionId,
						subscription: subscription

						}, function(error) {
						stripePluginCallback(error, originDb, task);
					});
				});
			});
		});
	};

	router['customers.listSubscriptions'] = function handleCustomersListSubscriptions(originDb, task) {
		hoodie.account.find('user', task.username, function(error, user) {
			if (error) {
					console.log(error);
			}

			hoodie.database(originDb).find('stripe/subscription', task.subscriptionId, function(error, subscription) {
				if (task.fromStripe) {
					stripe.customers.listSubscriptions(user.stripeCustomerId, function(error, subscriptions) {
						stripePluginCallback(error, originDb, task);
					});

				} else {
					stripePluginCallback(error, originDb, task);
				}
			});
		});
	};

	var stripePluginCallback = function(error, originDb, task) {
		if ( error ) {
			hoodie.task.error(originDb, task, error);
		}

		return hoodie.task.success(originDb, task);
	};

	doneCallback();
};