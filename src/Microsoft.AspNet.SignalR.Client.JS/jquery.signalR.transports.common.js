﻿// Copyright (c) Microsoft Open Technologies, Inc. All rights reserved. See License.md in the project root for license information.

/*global window:false */
/// <reference path="jquery.signalR.core.js" />

(function ($, window, undefined) {
    "use strict";

    var signalR = $.signalR,
        events = $.signalR.events,
        changeState = $.signalR.changeState,
        transportLogic;

    signalR.transports = {};

    function checkIfAlive(connection) {
        var keepAliveData = connection.keepAliveData,
            diff,
            timeElapsed;

        // Only check if we're connected
        if (connection.state === signalR.connectionState.connected) {
            diff = new Date();

            diff.setTime(diff - keepAliveData.lastKeepAlive);
            timeElapsed = diff.getTime();

            // Check if the keep alive has completely timed out
            if (timeElapsed >= keepAliveData.timeout) {
                connection.log("Keep alive timed out.  Notifying transport that connection has been lost.");

                // Notify transport that the connection has been lost
                connection.transport.lostConnection(connection);
            } else if (timeElapsed >= keepAliveData.timeoutWarning) {
                // This is to assure that the user only gets a single warning
                if (!keepAliveData.userNotified) {
                    connection.log("Keep alive has been missed, connection may be dead/slow.");
                    $(connection).triggerHandler(events.onConnectionSlow);
                    keepAliveData.userNotified = true;
                }
            } else {
                keepAliveData.userNotified = false;
            }
        }

        // Verify we're monitoring the keep alive
        // We don't want this as a part of the inner if statement above because we want keep alives to continue to be checked
        // in the event that the server comes back online (if it goes offline).
        if (keepAliveData.monitoring) {
            window.setTimeout(function () {
                checkIfAlive(connection);
            }, keepAliveData.checkInterval);
        }
    }

    function isConnectedOrReconnecting(connection) {
        return connection.state === signalR.connectionState.connected ||
               connection.state === signalR.connectionState.reconnecting;
    }

    function addConnectionData(url, connectionData) {
        var appender = url.indexOf("?") !== -1 ? "&" : "?";

        if (connectionData) {
            url += appender + "connectionData=" + window.encodeURIComponent(connectionData);
        }

        return url;
    }

    transportLogic = signalR.transports._logic = {
        pingServer: function (connection) {
            /// <summary>Pings the server</summary>
            /// <param name="connection" type="signalr">Connection associated with the server ping</param>
            /// <returns type="signalR" />
            var baseUrl, url, deferral = $.Deferred();

            if (connection.transport) {
                baseUrl = connection.transport.name === "webSockets" ? "" : connection.baseUrl;
                url = baseUrl + connection.appRelativeUrl + "/ping";

                url = transportLogic.prepareQueryString(connection, url);

                $.ajax(
                    $.extend({}, $.signalR.ajaxDefaults, {
                        xhrFields: { withCredentials: connection.withCredentials },
                        url: url,
                        type: "GET",
                        contentType: connection.contentType,
                        data: {},
                        dataType: connection.ajaxDataType,
                        success: function (result) {
                            var data;

                            try {
                                data = connection._parseResponse(result);
                            }
                            catch (error) {
                                deferral.reject(
                                    signalR._.transportError(
                                        signalR.resources.pingServerFailedParse,
                                        connection.transport,
                                        error
                                    )
                                );
                                connection.stop();
                                return;
                            }

                            if (data.Response === "pong") {
                                deferral.resolve();
                            }
                            else {
                                deferral.reject(
                                    signalR._.transportError(
                                        signalR._.format(signalR.resources.pingServerFailedInvalidResponse, result.responseText),
                                        connection.transport
                                    )
                                );
                            }
                        },
                        error: function (error) {
                            if (error.status === 401 || error.status === 403) {
                                deferral.reject(
                                    signalR._.transportError(
                                        signalR._.format(signalR.resources.pingServerFailedStatusCode, error.status),
                                        connection.transport,
                                        error
                                    )
                                );
                                connection.stop();
                            }
                            else {
                                deferral.reject(
                                    signalR._.transportError(
                                        signalR.resources.pingServerFailed,
                                        connection.transport,
                                        error
                                    )
                                );
                            }
                        }
                    }
                ));

            }
            else {
                deferral.reject(
                    signalR._.transportError(
                        signalR.resources.noConnectionTransport,
                        connection.transport
                    )
                );
            }

            return deferral.promise();
        },

        prepareQueryString: function (connection, url) {
            url = transportLogic.addQs(url, connection.qs);

            return addConnectionData(url, connection.data);
        },

        addQs: function (url, qs) {
            var appender = url.indexOf("?") !== -1 ? "&" : "?",
                firstChar;

            if (!qs) {
                return url;
            }

            if (typeof (qs) === "object") {
                return url + appender + $.param(qs);
            }

            if (typeof (qs) === "string") {
                firstChar = qs.charAt(0);

                if (firstChar === "?" || firstChar === "&") {
                    appender = "";
                }

                return url + appender + qs;
            }

            throw new Error("Query string property must be either a string or object.");
        },

        getUrl: function (connection, transport, reconnecting, poll) {
            /// <summary>Gets the url for making a GET based connect request</summary>
            var baseUrl = transport === "webSockets" ? "" : connection.baseUrl,
                url = baseUrl + connection.appRelativeUrl,
                qs = "transport=" + transport + "&connectionToken=" + window.encodeURIComponent(connection.token);

            if (connection.groupsToken) {
                qs += "&groupsToken=" + window.encodeURIComponent(connection.groupsToken);
            }

            if (!reconnecting) {
                url += "/connect";
            } else {
                if (poll) {
                    // longPolling transport specific
                    url += "/poll";
                } else {
                    url += "/reconnect";
                }

                if (connection.messageId) {
                    qs += "&messageId=" + window.encodeURIComponent(connection.messageId);
                }
            }
            url += "?" + qs;
            url = transportLogic.prepareQueryString(connection, url);
            url += "&tid=" + Math.floor(Math.random() * 11);
            return url;
        },

        maximizePersistentResponse: function (minPersistentResponse) {
            return {
                MessageId: minPersistentResponse.C,
                Messages: minPersistentResponse.M,
                Initialized: typeof (minPersistentResponse.S) !== "undefined" ? true : false,
                Disconnect: typeof (minPersistentResponse.D) !== "undefined" ? true : false,
                ShouldReconnect: typeof (minPersistentResponse.T) !== "undefined" ? true : false,
                LongPollDelay: minPersistentResponse.L,
                GroupsToken: minPersistentResponse.G
            };
        },

        updateGroups: function (connection, groupsToken) {
            if (groupsToken) {
                connection.groupsToken = groupsToken;
            }
        },

        stringifySend: function (connection, message) {
            if (typeof (message) === "string" || typeof (message) === "undefined" || message === null) {
                return message;
            }
            return connection.json.stringify(message);
        },

        ajaxSend: function (connection, data) {
            var payload = transportLogic.stringifySend(connection, data),
                url = connection.url + "/send" + "?transport=" + connection.transport.name + "&connectionToken=" + window.encodeURIComponent(connection.token),
                onFail = function (error, connection) {
                    $(connection).triggerHandler(events.onError, [signalR._.transportError(signalR.resources.sendFailed, connection.transport, error), data]);
                };

            url = transportLogic.prepareQueryString(connection, url);

            return $.ajax(
                $.extend({}, $.signalR.ajaxDefaults, {
                    xhrFields: { withCredentials: connection.withCredentials },
                    url: url,
                    type: connection.ajaxDataType === "jsonp" ? "GET" : "POST",
                    contentType: signalR._.defaultContentType,
                    dataType: connection.ajaxDataType,
                    data: {
                        data: payload
                    },
                    success: function (result) {
                        var res;

                        if (result) {
                            try {
                                res = connection._parseResponse(result);
                            }
                            catch (error) {
                                onFail(error, connection);
                                connection.stop();
                                return;
                            }

                            $(connection).triggerHandler(events.onReceived, [res]);
                        }
                    },
                    error: function (error, textStatus) {
                        if (textStatus === "abort" || textStatus === "parsererror") {
                            // The parsererror happens for sends that don't return any data, and hence
                            // don't write the jsonp callback to the response. This is harder to fix on the server
                            // so just hack around it on the client for now.
                            return;
                        }

                        onFail(error, connection);
                    }
                }
            ));
        },

        ajaxAbort: function (connection, async) {
            if (typeof (connection.transport) === "undefined") {
                return;
            }

            // Async by default unless explicitly overidden
            async = typeof async === "undefined" ? true : async;

            var url = connection.url + "/abort" + "?transport=" + connection.transport.name + "&connectionToken=" + window.encodeURIComponent(connection.token);
            url = transportLogic.prepareQueryString(connection, url);

            $.ajax(
                $.extend({}, $.signalR.ajaxDefaults, {
                    xhrFields: { withCredentials: connection.withCredentials },
                    url: url,
                    async: async,
                    timeout: 1000,
                    type: "POST",
                    contentType: connection.contentType,
                    dataType: connection.ajaxDataType,
                    data: {}
                }
            ));

            connection.log("Fired ajax abort async = " + async + ".");
        },

        tryInitialize: function (persistentResponse, onInitialized) {
            if (persistentResponse.Initialized) {
                onInitialized();
            }
        },

        processMessages: function (connection, minData, onInitialized) {
            var data,
                $connection = $(connection);

            // If our transport supports keep alive then we need to update the last keep alive time stamp.
            // Very rarely the transport can be null.
            if (connection.transport && connection.transport.supportsKeepAlive && connection.keepAliveData.activated) {
                this.updateKeepAlive(connection);
            }

            if (minData) {
                data = this.maximizePersistentResponse(minData);

                if (data.Disconnect) {
                    connection.log("Disconnect command received from server.");

                    // Disconnected by the server
                    connection.stop(false, false);
                    return;
                }

                this.updateGroups(connection, data.GroupsToken);

                if (data.MessageId) {
                    connection.messageId = data.MessageId;
                }

                if (data.Messages) {
                    $.each(data.Messages, function (index, message) {
                        $connection.triggerHandler(events.onReceived, [message]);
                    });

                    transportLogic.tryInitialize(data, onInitialized);
                }
            }
        },

        monitorKeepAlive: function (connection) {
            var keepAliveData = connection.keepAliveData,
                that = this;

            // If we haven't initiated the keep alive timeouts then we need to
            if (!keepAliveData.monitoring) {
                keepAliveData.monitoring = true;

                // Initialize the keep alive time stamp ping
                that.updateKeepAlive(connection);

                // Save the function so we can unbind it on stop
                connection.keepAliveData.reconnectKeepAliveUpdate = function () {
                    that.updateKeepAlive(connection);
                };

                // Update Keep alive on reconnect
                $(connection).bind(events.onReconnect, connection.keepAliveData.reconnectKeepAliveUpdate);

                connection.log("Now monitoring keep alive with a warning timeout of " + keepAliveData.timeoutWarning + " and a connection lost timeout of " + keepAliveData.timeout + ".");
                // Start the monitoring of the keep alive
                checkIfAlive(connection);
            } else {
                connection.log("Tried to monitor keep alive but it's already being monitored.");
            }
        },

        stopMonitoringKeepAlive: function (connection) {
            var keepAliveData = connection.keepAliveData;

            // Only attempt to stop the keep alive monitoring if its being monitored
            if (keepAliveData.monitoring) {
                // Stop monitoring
                keepAliveData.monitoring = false;

                // Remove the updateKeepAlive function from the reconnect event
                $(connection).unbind(events.onReconnect, connection.keepAliveData.reconnectKeepAliveUpdate);

                // Clear all the keep alive data
                connection.keepAliveData = {};
                connection.log("Stopping the monitoring of the keep alive.");
            }
        },

        updateKeepAlive: function (connection) {
            connection.keepAliveData.lastKeepAlive = new Date();
        },

        ensureReconnectingState: function (connection) {
            if (changeState(connection,
                        signalR.connectionState.connected,
                        signalR.connectionState.reconnecting) === true) {
                $(connection).triggerHandler(events.onReconnecting);
            }
            return connection.state === signalR.connectionState.reconnecting;
        },

        clearReconnectTimeout: function (connection) {
            if (connection && connection._.reconnectTimeout) {
                window.clearTimeout(connection._.reconnectTimeout);
                delete connection._.reconnectTimeout;
            }
        },

        reconnect: function (connection, transportName) {
            var transport = signalR.transports[transportName],
                that = this;

            // We should only set a reconnectTimeout if we are currently connected
            // and a reconnectTimeout isn't already set.
            if (isConnectedOrReconnecting(connection) && !connection._.reconnectTimeout) {
                connection._.reconnectTimeout = window.setTimeout(function () {
                    transport.stop(connection);

                    if (that.ensureReconnectingState(connection)) {
                        connection.log(transportName + " reconnecting.");
                        transport.start(connection);
                    }
                }, connection.reconnectDelay);
            }
        },

        handleParseFailure: function (connection, result, error, onFailed) {
            // If we're in the initialization phase trigger onFailed, otherwise stop the connection.
            if (connection.state === signalR.connectionState.connecting) {
                connection.log("Failed to parse server response while attempting to connect.");
                onFailed();
            } else {
                $(connection).triggerHandler(events.onError, [signalR._.transportError(
                    signalR._.format(signalR.resources.parseFailed, result),
                    connection.transport,
                    error)]);
                connection.stop();
            }
        },

        foreverFrame: {
            count: 0,
            connections: {}
        }
    };

}(window.jQuery, window));
