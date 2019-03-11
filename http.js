import Axios from 'axios'
import AxiosFinally from 'promise.prototype.finally'
import { parseLinks, getEndpoint as ge } from 'hateoas-parser'
import {transform, get, concat, uniq, isObject, toPairs, isFunction} from 'lodash'

const openBlob = function (blob, filename, forceDownload) {
  let url,
    popup

  if (window.navigator && window.navigator.msSaveOrOpenBlob) {
    popup = window.navigator.msSaveOrOpenBlob(blob, filename)
  } else {
    url = window.URL.createObjectURL(blob)

    if (forceDownload) {
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', filename)
      document.body.appendChild(link)
      link.click()
      return
    }

    popup = window.open(url)
  }

  // error display
  window.setTimeout(function () {
    if (!popup || popup.closed) {
      // Create and fire a custom event
      var event = new CustomEvent("popupBlocked", {
        "detail": {
          "message": "Your document should have been displayed in a popup. But your browser prevent the popup to open. Please check the small icon in your address bar.",
          "code": "POPUP_BLOCKED"
        }
      });
      document.dispatchEvent(event);
    }
  }, 1000)
}

const ExtendedAxios = {
  config: {
    cachebuster: {
      callback: null,
      methods: []
    }
  },

  setCacheBuster (callback, methods = ['GET']) {
    this.config.cachebuster.callback = callback
    this.config.cachebuster.methods = methods
  },

  getEndpoint (url, axiosConfig) {
    let finalConfig = Object.assign({
      method: 'GET',
      url: url
    }, (axiosConfig || {}))

    // cachebusting
    if (isFunction(this.config.cachebuster.callback) && this.config.cachebuster.methods.indexOf(finalConfig.method) > -1) {
      finalConfig.params = Object.assign(finalConfig.params || {}, {t: this.config.cachebuster.callback()})
    }

    return this(finalConfig)
      .then(response => {
        if (!response) {
          return {}
        }
        return response.data
      })
  },
  loadIndex (endpoint) {
    return this.getEndpoint(endpoint)
  },
  getRelEndpoint (index, rel, params, axiosConfig, version) {
    return this.getEndpoint(ge(index, rel, params, version), axiosConfig)
  },
  followLink (resource, ...params) {
    return this.getRelEndpoint(parseLinks(resource), ...params)
  },
  _getBinary (index, rel, params, axiosConfig, version) {
    axiosConfig = axiosConfig || {}
      axiosConfig.transformResponse = [function (resBlob) {
        // try to decode the Blob content and parse it as JSON
        // if it is JSON, that means it's an error and not an actual Blob result.
        return new Promise((resolve, reject) => {
          let reader = new FileReader()
          reader.addEventListener('abort', reject)
          reader.addEventListener('error', reject)
          reader.addEventListener('loadend', () => {
            resolve(reader.result)
          })
          reader.readAsText(resBlob)
        })
          .then(resText => {
            try {
              return JSON.parse(resText)
            } catch (e) {
              return resBlob
            }
          })
      }]
      return this.followLink(index, rel, params, Object.assign({}, (axiosConfig || {}), {responseType: 'blob'}), version)
  },
  downloadBinary (index, rel, params, axiosConfig, version) {
    return this._getBinary(index, rel, params, axiosConfig, version)
      .then(response => {
        let filename = index.fileName || 'document.pdf'
        openBlob(response, filename, true)
      })
  },
  openBinary (index, rel, params, axiosConfig, version) {
    return this._getBinary(index, rel, params, axiosConfig, version)
      .then(response => {
        let filename = index.fileName || 'document.pdf'
        openBlob(response, filename)
      })
  }
}

// shim the finally method
AxiosFinally.shim()

export default {

  create (config) {
    return Object.assign(Axios.create(config), ExtendedAxios)
  },

  createStandard (config) {
    return this.create({
      withCredentials: true,
      headers: {
        'X-Requested-With': 'XMLHttpRequest'
      },
      baseURL: config.apiUri + config.apiBasePath
    })
  },

  createWithHeaders (config, payload) {
    let customHeaders = {}
    if (config.headersMap) {
      customHeaders = transform(config.headersMap, (acc, path, headerName) => {
        let headerValue = get(payload, path)
        if (headerValue) {
          acc[headerName] = headerValue
        }
        return acc
      }, {})
    }
    let headers = Object.assign({
      'X-Requested-With': 'XMLHttpRequest'
    }, customHeaders)

    return this.create({
      withCredentials: true,
      headers: headers,
      baseURL: config.apiUri + config.apiBasePath
    })
  },

  /**
   * Loads all versions of an index endpoint and
   * create a versioned list of links
   *
   * @param {Axios} http Axios configured instance
   * @param {String|Object} endpointDefinition One or several index endpoints
   * @returns {Promise}
   */
  loadVersionedIndex (http, endpointDefinition) {
    if (!isObject(endpointDefinition)) {
      endpointDefinition = {
        default: endpointDefinition
      }
    }
    let endpoints = toPairs(endpointDefinition)
    let promises = endpoints.map((ep) => {
      return {
        key: ep[0],
        promise: http.loadIndex(ep[1])
      }
    })
    return Axios.all(promises.map(ep => ep.promise))
      .then(results => {
        promises.map((info, index) => {
          info.result = results[index].data || results[index].index || {}
          return info
        })

        // extract all 'rel' values
        let rels = uniq(concat(...promises.map(val => val.result.links)).map(obj => obj.rel))
        rels.sort()

        let links = rels.map((rel) => {
          let hrefs = promises.reduce((acc, obj) => {
            let inHere = obj.result.links.find(link => link.rel === rel)
            if (inHere) {
              acc[obj.key] = inHere.href
            }
            return acc
          }, {})
          if (Object.keys(hrefs).length === 1) {
            hrefs = hrefs[Object.keys(hrefs)[0]]
          }

          return {
            rel: rel,
            href: hrefs
          }
        })

        return {links: links}
      })
  }
}
