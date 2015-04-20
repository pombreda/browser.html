/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

define((require, exports, module) => {

  'use strict';

  const {DOM} = require('react');
  const Component = require('omniscient');
  const ClassSet = require('common/class-set');
  const {focus, blur} = require('common/focusable');
  const {isPrivileged, getDomainName, getManifestURL} = require('common/url-helper');
  const {fromDOMRequest, fromEvent} = require('lang/promise');
  const {compose, curry} = require('lang/functional');
  const {isActive, isSelected} = require('./deck/actions');
  const {getHardcodedColors} = require('./theme');
  const {IFrame} = require('./iframe');
  const {Record, List, Maybe, Any} = require('typed-immutable/index');
  const {Map} = require('immutable');
  const uuid = require('uuid');

  const makeTileURI = input => `tiles/${getDomainName(input)}.png`;

  const WebView = Record({
    id: String,
    // What the user wrote in the locationbar for this specific view
    userInput: String(''),
    // Zoom level of the web content.
    zoom: Number(1),
    // State of the web content:
    // 'loading'|'loaded'|'stop'|'reload'|'goBack'|'goForward'
    readyState: Maybe(String),
    // `true` if web content is currently loading.
    isLoading: Boolean(false),
    // Has the server replied yet
    isConnecting: Boolean(false),

    startLoadingTime: Number(-1),
    // When the server replied first (while loading)
    connectedTime: Number(-1),
    endLoadingTime: Number(-1),

    // `true` if web content has a focus.
    isFocused: Boolean(false),
    // `true` if this is currently active web viewer, in other words
    // if this is a web viewer currently displayed.
    isActive: Boolean(false),
    // `true` if this is currently selected web viewer. In most times
    // is in sync with `isActive` although it does gets out of sync
    // during tab switching when user is seleceting tab to switch to.
    isSelected: Boolean(false),
    isPinned: Boolean(false),
    // URI that is loaded / loading.
    uri: Maybe(String),
    // Currently loaded content's title.
    title: Maybe(String),
    // Icons from the loaded web content.
    icons: Any,
    // Metadata of the loaded web content.
    meta: Any,
    // Web content color info, should probably be moved elsewhere.
    backgroundColor: Maybe(String),
    foregroundColor: Maybe(String),
    isDark: Boolean(false),
    // Web content network security info.
    securityState: String('insecure'),
    securityExtendedValidation: Boolean(false),
    // Flags indicating if web viewer can navigate back / forward.
    canGoBack: Boolean(false),
    canGoForward: Boolean(false),

    contentOverflows: Boolean(false),
    thumbnail: Maybe(String)
  });


  const set = field => value => target => target.set(field, value)
  const patch = delta => state => state.merge(delta)
  const In = (...path) => edit => state =>
    state.updateIn(path, edit);

  // Returns state with fields that represent state that can not be restored
  // cleared.
  WebView.persistent = patch({
    thumbnail: void(0),
    readyState: void(0),
    isLoading: void(0),
    isConnecting: void(0),

    startLoadingTime: void(0),
    connectedTime: void(0),
    endLoadingTime: void(0),

    backgroundColor: void(0),
    foregroundColor: void(0),
    isDark: void(0),

    title: void(0),
    securityState: void(0),
    securityExtendedValidation: void(0),
    canGoBack: void(0),
    canGoForward: void(0)
  });

  WebView.blur = blur;
  WebView.focus = focus;

  WebView.open = (state={}) =>
    WebView(Object.assign({id: uuid()}, state))

  // Creates a state that when rendered triggers a content reload.
  WebView.reload = patch({readyState: 'reload'});

  // Creates a state that when rendered aborts a content load.
  WebView.stop = patch({readyState: 'stop'});

  // Creates a state that when rendered triggers a navigation back.
  WebView.goBack = patch({readyState: 'goBack'});

  // Creates a state that when rendered triggers a navigation forward.
  WebView.goForward = patch({readyState: 'goForward'});

  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 2;
  const ZOOM_STEP = 0.1;

  const zoomIn = value => Math.min(ZOOM_MAX, value + ZOOM_STEP);
  const zoomOut = value => Math.max(ZOOM_MIN, value - ZOOM_STEP);

  // Creates a state with zoom increased step further.
  WebView.zoomIn = state => state.update('zoom', zoomIn);
  WebView.zoomOut = state => state.update('zoom', zoomOut);
  WebView.zoomReset = state => state.remove('zoom');


  WebView.setMetaData = set('meta');
  WebView.setTitle = set('title');
  WebView.setCanGoBack = set('canGoBack');
  WebView.setCanGoForward = set('canGoForward');
  WebView.startLoad = state => state.merge({
    readyState: 'loading',
    isLoading: true,
    isConnecting: true,
    startLoadingTime: performance.now(),
    icons: void(0),
    thumbnail: void(0),
    title: void(0),
    securityState: void(0),
    securityExtendedValidation: void(0),
    canGoBack: void(0),
    canGoForward: void(0)
  });
  WebView.endLoad = state => state.merge({
    isConnecting: false,
    endLoadingTime: performance.now(),
    readyState: 'loaded',
    isLoading: false
  });
  WebView.changeProgress = connectedTime => state =>
    !state.isConnecting ? state :
    state.merge({isConnecting: false,
                 connectedTime: performance.now()});

  WebView.changeLocation = value => state => state.merge({
    uri: value,
    readyState: state.isLoading ? 'loading' : 'loaded',
    userInput: value
  }).merge(getHardcodedColors(value));

  WebView.changeIcon = icon => state =>
    state.get('icons') ? state.setIn(['icons', icon.href], icon) :
    state.set('icons', Map([[icon.href, icon]]));

  WebView.changeSecurity = security => state => state.merge({
    securityState: security.state,
    securityExtendedValidation: security.extendedValidation
  });

  WebView.setContentOverflows = set('contentOverflows')

  WebView.onThumbnailChanged = edit => blob =>
    edit(state => state.set('thumbnail', URL.createObjectURL(blob)));

  WebView.render = Component('WebView', (state, {onOpen, onOpenBg, onClose, edit}) => {
    // Do not render anything unless viewer has an `uri`
    if (!state.uri) return null;

    return IFrame({
      className: ClassSet({
        'iframes-frame': true,
        webview: true,
        contentoverflows: state.contentOverflows,
        // We need to style hidden iframes that don't have tiles differntly
        // to workaround #266 & be able to capture screenshots.
        rendered: state.thumbnail
      }),
      style: {
        MozUserSelect: 'none'
      },
      isBrowser: true,
      isRemote: true,
      mozApp: isPrivileged(state.uri) ? getManifestURL().href : null,
      allowFullScreen: true,


      isVisible: state.isActive || state.isSelected,
      hidden: !state.isActive,

      zoom: state.zoom,
      isFocused: state.isFocused,
      uri: state.uri,
      readyState: state.readyState,


      onCanGoBackChange: event => edit(WebView.setCanGoBack(event.detail)),
      onCanGoForwardChange: event => edit(WebView.setCanGoForward(event.detail)),

      onBlur: event => edit(WebView.blur),
      onFocus: event => edit(WebView.focus),
      // onAsyncScroll: WebView.onUnhandled,
      onClose: event => onClose(state.id),
      onOpenWindow: event => onOpen(event.detail.url),
      onOpenTab: event => onOpenBg(event.detail.url),
      onContextMenu: event => console.log(event),
      onError: event => console.error(event),
      onLoadStart: event => edit(WebView.startLoad),
      onLoadEnd: event => edit(WebView.endLoad),
      onMetaChange: event => edit(WebView.setMetaData(event.detail)),
      onIconChange: event => edit(WebView.changeIcon(event.detail)),
      onLocationChange: event => {
        edit(WebView.changeLocation(event.detail));
        requestThumbnail(event.target).
          then(WebView.onThumbnailChanged(edit));
      },
      onSecurityChange: event => edit(WebView.changeSecurity(event.detail)),
      onTitleChange: event => edit(WebView.setTitle(event.detail)),
      onPrompt: event => console.log(event),
      onAuthentificate: event => console.log(event),
      onScrollAreaChange: event =>
        edit(WebView.setContentOverflows(event.detail.height >
                                         event.target.parentNode.clientHeight)),
      onLoadProgressChange: event => edit(WebView.changeProgress(event))
    });
  });


  const fetchScreenshot = iframe =>
    fromDOMRequest(iframe.getScreenshot(100 * devicePixelRatio,
                                        62.5 * devicePixelRatio,
                                        'image/png'));

  // This is temporary workraound once we've get a history database
  // we will be queyring it instead (see #153)
  const fetchThumbnail = uri => new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('GET', `tiles/${getDomainName(uri)}.png`);
    request.responseType = 'blob';
    request.send();
    request.onload = event => {
      if (request.status === 200) {
        resolve(request.response);
      } else {
        reject(request.statusText);
      }
    }
    request.onerror = event => reject();
  });

  const requestThumbnail = iframe => {
    // Create a promise that is rejected when iframe location is changes,
    // in order to abort task if this happens before we have a response.
    const abort = fromEvent(iframe, 'mozbrowserlocationchange').
      then(event => Promise.reject(event));

    // Create a promise that is resolved once iframe ends loading, it will
    // be used to defer a screenshot request.
    const loaded = fromEvent(iframe, 'mozbrowserloadend');

    // Request a thumbnail from DB.
    const thumbnail = fetchThumbnail(iframe.getAttribute('uri')).
    // If thumbnail isn't in database then we race `loaded` against `abort`
    // and if `loaded` wins we fetch a screenshot that will be our thumbnail.
    catch(_ => Promise.
          race([abort, loaded]).
          then(_ => fetchScreenshot(iframe)));

    // Finally we return promise that rejects if `abort` wins and resolves to a
    // `thumbnail` if we get it before `abort`.
    return Promise.race([abort, thumbnail]);
  }

  const id = x => x.id

  const WebViews = List(WebView)

  const WebViewBox = Record({
    isActive: Boolean(true),
    items: WebViews
  });

  // WebView deck will always inject frames by order of their id. That way
  // no iframes will need to be removed / injected when order of tabs change.
  WebViewBox.render = Component(function WebViewsBox(state, handlers) {
    const {onOpen, onOpenBg, onClose, edit} = handlers;
    const {items, isActive} = state;

    return DOM.div({
      className: 'iframes',
      hidden: !isActive,
    }, items.sortBy(id).map(webView => WebView.render(webView.id, webView, {
        onOpen, onOpenBg, onClose,
        edit: compose(edit, In(items.indexOf(webView)))
    })))
  });


  // Exports:

  exports.WebViews = WebViews;
  exports.WebView = WebView;
  exports.WebViewBox = WebViewBox;

});
