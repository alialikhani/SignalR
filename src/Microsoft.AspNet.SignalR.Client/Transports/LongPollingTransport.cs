﻿// Copyright (c) Microsoft Open Technologies, Inc. All rights reserved. See License.md in the project root for license information.

using System;
using System.Diagnostics.CodeAnalysis;
using System.IO;
using System.Threading;
using Microsoft.AspNet.SignalR.Client.Http;
using Microsoft.AspNet.SignalR.Client.Infrastructure;
using Microsoft.AspNet.SignalR.Infrastructure;

namespace Microsoft.AspNet.SignalR.Client.Transports
{
    public class LongPollingTransport : HttpBasedTransport
    {
        /// <summary>
        /// The time to wait after a connection drops to try reconnecting.
        /// </summary>
        public TimeSpan ReconnectDelay { get; set; }

        /// <summary>
        /// The time to wait after an error happens to continue polling.
        /// </summary>
        public TimeSpan ErrorDelay { get; set; }

        public LongPollingTransport()
            : this(new DefaultHttpClient())
        {
        }

        public LongPollingTransport(IHttpClient httpClient)
            : base(httpClient, "longPolling")
        {
            ReconnectDelay = TimeSpan.FromSeconds(5);
            ErrorDelay = TimeSpan.FromSeconds(2);
        }

        /// <summary>
        /// Indicates whether or not the transport supports keep alive
        /// </summary>
        public override bool SupportsKeepAlive
        {
            get
            {
                return false;
            }
        }

        protected override void OnStart(IConnection connection,
                                        string connectionData,
                                        CancellationToken disconnectToken,
                                        TransportInitializationHandler initializeHandler)
        {
            var requestHandler = new PollingRequestHandler(HttpClient);
            var negotiateInitializer = new NegotiateInitializer(initializeHandler);

            Action<IRequest> initializeAbort = request => { negotiateInitializer.Abort(disconnectToken); };

            requestHandler.OnError += negotiateInitializer.Complete;
            requestHandler.OnAbort += initializeAbort;

            // If the transport fails to initialize we want to silently stop
            initializeHandler.OnFailure += () =>
            {
                requestHandler.Stop();
            };

            // Once we've initialized the connection we need to tear down the initializer functions and assign the appropriate onMessage function
            negotiateInitializer.Initialized += () =>
            {
                requestHandler.OnError -= negotiateInitializer.Complete;
                requestHandler.OnAbort -= initializeAbort;
            };

            // Add additional actions to each of the PollingRequestHandler events
            PollingSetup(connection, connectionData, disconnectToken, requestHandler, negotiateInitializer.Complete);

            requestHandler.Start();
        }

        [SuppressMessage("Microsoft.Maintainability", "CA1502:AvoidExcessiveComplexity", Justification = "We will refactor later.")]
        private void PollingSetup(IConnection connection,
                                  string data,
                                  CancellationToken disconnectToken,
                                  PollingRequestHandler requestHandler,
                                  Action onInitialized)
        {
            // reconnectInvoker is created new on each poll
            var reconnectInvoker = new ThreadSafeInvoker();

            var disconnectRegistration = disconnectToken.SafeRegister(state =>
            {
                reconnectInvoker.Invoke();
                requestHandler.Stop();
            }, null);

            requestHandler.ResolveUrl = () =>
            {
                var url = connection.Url;

                if (connection.MessageId == null)
                {
                    url += "connect";
                    connection.Trace(TraceLevels.Events, "LP Connect: {0}", url);
                }
                else if (IsReconnecting(connection))
                {
                    url += "reconnect";
                    connection.Trace(TraceLevels.Events, "LP Reconnect: {0}", url);
                }
                else
                {
                    url += "poll";
                    connection.Trace(TraceLevels.Events, "LP Poll: {0}", url);
                }

                url += GetReceiveQueryString(connection, data);

                return url;
            };

            requestHandler.PrepareRequest += req =>
            {
                connection.PrepareRequest(req);
            };

            requestHandler.OnMessage += message =>
            {
                var shouldReconnect = false;
                var disconnectedReceived = false;

                connection.Trace(TraceLevels.Messages, "LP: OnMessage({0})", message);

                TransportHelper.ProcessResponse(connection,
                                                message,
                                                out shouldReconnect,
                                                out disconnectedReceived,
                                                onInitialized);

                if (IsReconnecting(connection))
                {
                    // If the timeout for the reconnect hasn't fired as yet just fire the 
                    // event here before any incoming messages are processed
                    TryReconnect(connection, reconnectInvoker);
                }

                if (shouldReconnect)
                {
                    // Transition into reconnecting state
                    connection.EnsureReconnecting();
                }

                if (disconnectedReceived)
                {
                    connection.Disconnect();
                }
            };

            requestHandler.OnError += exception =>
            {
                reconnectInvoker.Invoke();

                // Transition into reconnecting state
                connection.EnsureReconnecting();

                // Sometimes a connection might have been closed by the server before we get to write anything
                // so just try again and raise OnError.
                if (!ExceptionHelper.IsRequestAborted(exception) && !(exception is IOException))
                {
                    connection.OnError(exception);
                }
                else
                {
                    requestHandler.Stop();
                }
            };

            requestHandler.OnPolling += () =>
            {
                // Capture the cleanup within a closure so it can persist through multiple requests
                TryDelayedReconnect(connection, reconnectInvoker);
            };

            requestHandler.OnAfterPoll = exception =>
            {
                if (AbortHandler.TryCompleteAbort())
                {
                    // Abort() was called, so don't reconnect
                    requestHandler.Stop();
                }
                else
                {
                    reconnectInvoker = new ThreadSafeInvoker();

                    if (exception != null)
                    {
                        // Delay polling by the error delay
                        return TaskAsyncHelper.Delay(ErrorDelay);
                    }
                }

                return TaskAsyncHelper.Empty;
            };

            requestHandler.OnAbort += _ =>
            {
                disconnectRegistration.Dispose();

                // Complete any ongoing calls to Abort()
                // If someone calls Abort() later, have it no-op
                AbortHandler.CompleteAbort();
            };
        }

        private void TryDelayedReconnect(IConnection connection, ThreadSafeInvoker reconnectInvoker)
        {
            if (IsReconnecting(connection))
            {
                TaskAsyncHelper.Delay(ReconnectDelay).Then(() =>
                {
                    TryReconnect(connection, reconnectInvoker);
                });
            }
        }

        private static void TryReconnect(IConnection connection, ThreadSafeInvoker reconnectInvoker)
        {
            // Fire the reconnect event after the delay.
            reconnectInvoker.Invoke((conn) => FireReconnected(conn), connection);
        }

        private static void FireReconnected(IConnection connection)
        {
            // Mark the connection as connected
            if (connection.ChangeState(ConnectionState.Reconnecting, ConnectionState.Connected))
            {
                connection.OnReconnected();
            }
        }

        private static bool IsReconnecting(IConnection connection)
        {
            return connection.State == ConnectionState.Reconnecting;
        }

        public override void LostConnection(IConnection connection)
        {

        }
    }
}
