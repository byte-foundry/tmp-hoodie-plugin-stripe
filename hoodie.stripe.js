'use strict';

Hoodie.extend(function(hoodie) {
	hoodie.stripe = {
		charges: {
			create: true,
			retrieve: true,
			update: true,
			list: true

		},
		customers: {
			create: true,
			createSubscription: true,
			updateSubscription: true,
			retrieveSubscription: true,
			cancelSubscription: true,
			listSubscriptions: true

		}
	};

	Object.keys(hoodie.stripe).forEach(function(val) {
		Object.keys(hoodie.stripe[val]).forEach(function(value) {
			hoodie.stripe[val][value] = function(message) {
				message.username = hoodie.account.username.toLowerCase();
				// toLowerCase on hoodie.account.username because hoodie.account.update seems to fail on recognizing user names with uppercase in it : only lowercase in task events
				message.subtype = val + '.' + value;
				return hoodie.task('stripe').start(message);
			}
		});
	});
});