"use strict";

const functions = require("firebase-functions");
const { dialogflow, List, CompletePurchase } = require("actions-on-google");
const request = require("request");
const { google } = require("googleapis");

const config = require("./config.json");
const serviceAccount = require(config.serviceAccountKeyFile);
const packageName = config.packageName;

const consumableProducts = ["coins"];

const app = dialogflow({
    debug: true
});

const createJwtClient = () => {
    const scopes = [
        "https://www.googleapis.com/auth/actions.purchases.digital"
    ];
    return new google.auth.JWT(
        serviceAccount.client_email,
        null,
        serviceAccount.private_key,
        scopes,
        null
    );
};

const getSkus = (tokens, conv) => {
    return new Promise((resolve, reject) => {
        const url = `https://actions.googleapis.com/v3/packages/${packageName}/skus:batchGet`;
        const convId = conv.request.conversation.conversationId;
        const param = {
            conversationId: convId,
            skuType: "SKU_TYPE_IN_APP",
            ids: [
                "premium",
                "coins"
            ]
        };
        request.post(url, {
            auth: {
                bearer: tokens.access_token
            },
            json: true,
            body: param
        }, (err, httpResponse, body) => {
            if (err) {
                reject(err);
            } else {
                const statusCode = httpResponse.statusCode;
                const statusMessage = httpResponse.statusMessage;
                console.log(`${statusCode}: ${statusMessage}`);
                console.log(JSON.stringify(body));
                resolve(body);
            }
        });
    });
};

const respondSkus = (conv, body) => {
    const skus = body.skus || [];
    if (skus.length > 0) {
        const list = {
            title: "Products",
            items: {}
        };
        skus.forEach(sku => {
            const key = `${sku.skuId.skuType},${sku.skuId.id}`
            list.items[key] = {
                title: sku.title,
                description: `${sku.description} | ${sku.formattedPrice}`
            };
        });
        list.items["cancel"] = {
            title: "Cancel",
            description: "Cancel purchase"
        };
        conv.ask("Which product do you want to order?");
        conv.ask(new List(list));
    } else {
        conv.ask("No products.");
    }
};

const findEntitlement = (conv, skuType, id) => {
    const entitlementGroups = conv.user.entitlements;
    const entitlementGroup = entitlementGroups.find(x => {
        return x.packageName === packageName;
    });
    if (entitlementGroup) {
        return entitlementGroup.entitlements.find(x => {
            return x.skuType === skuType.substring(9)
                && x.sku === id;
        });
    }
    return undefined;
};

const consume = (tokens, conv, entitlement) => {
    return new Promise((resolve, reject) => {
        const convId = conv.request.conversation.conversationId;
        const purchaseToken = entitlement.inAppDetails.inAppPurchaseData.purchaseToken;
        const url = `https://actions.googleapis.com/v3/conversations/${convId}/entitlement:consume`;
        request.post(url, {
            auth: {
                bearer: tokens.access_token
            },
            json: true,
            body: {
                purchaseToken
            }
        }, (err, httpResponse, body) => {
            if (err) {
                reject(err);
            } else {
                const statusCode = httpResponse.statusCode;
                const statusMessage = httpResponse.statusMessage;
                console.log(`${statusCode}: ${statusMessage}`);
                resolve();
            }
        });
    });
};

app.intent("Gather information", conv => {
    const SCREEN_OUTPUT = 'actions.capability.SCREEN_OUTPUT';
    if (!conv.surface.capabilities.has(SCREEN_OUTPUT)) {
        conv.ask("Sorry, try this on a screen device or " +
            "select the phone surface in the simulator.");
        return;
    }
    return new Promise((resolve, reject) => {
        createJwtClient().authorize((err, tokens) => {
            if (err) {
                reject(`Auth error: ${err}`);
            } else {
                getSkus(tokens, conv).then(body => {
                    respondSkus(conv, body);
                    resolve();
                }).catch(err => {
                    reject(`API request error: ${err}`);
                });
            }
        });
    });
});

app.intent("actions.intent.OPTION", (conv, params, option) => {
    if (option === "cancel") {
        conv.ask("Canceled");
        return;
    }
    const [skuType, id] = option.split(",");
    const entitlement = findEntitlement(conv, skuType, id);
    if (entitlement && consumableProducts.includes(id)) {
        return new Promise((resolve, reject) => {
            createJwtClient().authorize((err, tokens) => {
                if (err) {
                    reject(`Auth error: ${err}`);
                    return;
                }
                consume(tokens, conv, entitlement).then(() => {
                    conv.close(`You purchased ${id} successfully.`);
                    resolve();
                }).catch(err => {
                    reject(`API request error: ${err}`);
                });
            });
        });
    } else {
        conv.ask(new CompletePurchase({
            skuId: {
                skuType: skuType,
                id: id,
                packageName: packageName
            }
        }));
    }
});

app.intent("actions.intent.COMPLETE_PURCHASE", conv => {
    const arg = conv.arguments.get("COMPLETE_PURCHASE_VALUE");
    console.log("User Decision: " + JSON.stringify(arg));
    if (!arg || !arg.purchaseStatus) {
        conv.close("Purchase failed. Please check logs.");
        return;
    }
    if (arg.purchaseStatus === "PURCHASE_STATUS_OK") {
        conv.close("Purchase completed! You are all set!");
    } else if (arg.purchaseStatus === "PURCHASE_STATUS_ALREADY_OWNED") {
        conv.close("Purchase failed. You have already owned the item.");
    } else if (arg.purchaseStatus === "PURCHASE_STATUS_ITEM_UNAVAILABLE") {
        conv.close("Purchase failed. Item is not available.");
    } else if (arg.purchaseStatus === "PURCHASE_STATUS_ITEM_CHANGE_REQUESTED") {
        conv.close("Purchase failed. Item change requested.");
    } else {
        conv.close("Purchase Failed:" + arg.purchaseStatus);
    }
});

exports.digitalGoodsTest = functions.https.onRequest(app);
