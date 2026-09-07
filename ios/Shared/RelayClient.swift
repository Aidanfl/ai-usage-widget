//
//  RelayClient.swift
//  AIUsage (shared)
//
//  GET R/v1/slots/{slotId} with `Authorization: Bearer <readToken>` (docs/PHONE-SYNC.md "Relay HTTP API"),
//  10 s timeout, then decrypt + decode. Errors are typed so the UI can word them.
//

import Foundation

enum RelayError: Error, LocalizedError, Equatable {
    case invalidURL
    case unauthorized               // 401 — read token does not match the slot
    case notFound                   // 404 — desktop has not pushed yet / slot expired (7 days)
    case httpStatus(Int)
    case timeout
    case offline
    case network(String)
    case badResponse
    case decrypt(String)
    case decode(String)

    var errorDescription: String? { return userMessage }

    /// Short, user-facing wording.
    var userMessage: String {
        switch self {
        case .invalidURL:
            return "The relay URL is invalid."
        case .unauthorized:
            return "The relay rejected this phone's read token — re-pair from the desktop widget."
        case .notFound:
            return "Desktop hasn't pushed yet — open the desktop widget (Settings ▸ Phone) and use “Push now”."
        case .httpStatus(let code):
            return "The relay returned HTTP \(code)."
        case .timeout:
            return "The relay did not answer within 10 seconds."
        case .offline:
            return "No internet connection."
        case .network(let message):
            return "Network error: \(message)"
        case .badResponse:
            return "Unexpected response from the relay."
        case .decrypt(let message):
            return message
        case .decode(let message):
            return "Could not read the payload: \(message)"
        }
    }
}

struct RelayClient {
    let pairing: Pairing
    var timeout: TimeInterval = 10

    init(pairing: Pairing, timeout: TimeInterval = 10) {
        self.pairing = pairing
        self.timeout = timeout
    }

    /// `R/v1/slots/{slotId}`
    var slotURL: URL? {
        return URL(string: pairing.relayURL.absoluteString + "/v1/slots/" + pairing.slotId)
    }

    /// `R/v1/health`
    var healthURL: URL? {
        return URL(string: pairing.relayURL.absoluteString + "/v1/health")
    }

    private func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        config.waitsForConnectivity = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.urlCache = nil
        return URLSession(configuration: config)
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let session = makeSession()
        defer { session.finishTasksAndInvalidate() }
        let result: (Data, URLResponse)
        do {
            result = try await session.data(for: request)
        } catch let urlError as URLError {
            switch urlError.code {
            case .timedOut:
                throw RelayError.timeout
            case .notConnectedToInternet, .networkConnectionLost, .dataNotAllowed, .internationalRoamingOff:
                throw RelayError.offline
            default:
                throw RelayError.network(urlError.localizedDescription)
            }
        } catch {
            throw RelayError.network(error.localizedDescription)
        }
        guard let http = result.1 as? HTTPURLResponse else { throw RelayError.badResponse }
        return (result.0, http)
    }

    /// Fetches the encrypted envelope for this pairing's slot.
    func fetchEnvelope() async throws -> Envelope {
        guard let url = slotURL else { throw RelayError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(pairing.readToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, http) = try await perform(request)
        switch http.statusCode {
        case 200:
            break
        case 401:
            throw RelayError.unauthorized
        case 404:
            throw RelayError.notFound
        default:
            throw RelayError.httpStatus(http.statusCode)
        }
        // No global date strategy: timestamps are ms numbers and ISO strings, handled by the models.
        do {
            return try JSONDecoder().decode(Envelope.self, from: data)
        } catch {
            throw RelayError.decode("envelope — \(error.localizedDescription)")
        }
    }

    /// Fetch + decrypt + decode. Returns the payload and the plaintext envelope (for `ts`).
    func fetchPayload() async throws -> (payload: PhonePayload, envelope: Envelope) {
        let envelope = try await fetchEnvelope()
        let plaintext: Data
        do {
            plaintext = try PayloadCrypto.decrypt(envelope: envelope, pairing: pairing)
        } catch let cryptoError as CryptoError {
            throw RelayError.decrypt(cryptoError.errorDescription ?? "Decryption failed.")
        } catch {
            throw RelayError.decrypt(error.localizedDescription)
        }
        do {
            let payload = try JSONDecoder().decode(PhonePayload.self, from: plaintext)
            return (payload: payload, envelope: envelope)
        } catch {
            throw RelayError.decode(error.localizedDescription)
        }
    }

    /// `GET /v1/health` → true when the relay answers 200.
    func health() async throws -> Bool {
        guard let url = healthURL else { throw RelayError.invalidURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = timeout
        let (_, http) = try await perform(request)
        return http.statusCode == 200
    }
}
