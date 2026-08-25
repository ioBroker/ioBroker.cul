'use strict';

const path = require('node:path');
const { tests } = require('@iobroker/testing');

// Start a real js-controller and this adapter
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test listUart5', getHarness => {
            it('Should return the list of serial ports', () => {
                return new Promise(resolve => {
                    const harness = getHarness();
                    harness.startAdapterAndWait().then(() => {
                        harness.sendTo('cul.0', 'listUart5', {}, resp => {
                            console.dir(resp);
                            resolve();
                        });
                    });
                });
            });
        });
    },
});
