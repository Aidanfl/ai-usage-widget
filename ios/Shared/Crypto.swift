//
//  Crypto.swift
//  AIUsage (shared)
//
//  Decrypts the relay envelope (docs/PHONE-SYNC.md "Encryption"):
//    { "v": 1, "iv": "<base64 std, 12 bytes>", "ct": "<base64 std, ciphertext || 16-byte tag>", "ts": ms }
//  AES-256-GCM, key = encKey, AAD = ASCII bytes of slotId.
//

import Foundation
import CryptoKit

/// Wire envelope stored on / served by the relay.
struct Envelope: Codable, Equatable {
    var v: Int?
    var iv: String?
    var ct: String?
    var ts: Double?

    var pushedDate: Date? { return Models.dateFromMs(ts) }
}

enum CryptoError: Error, LocalizedError, Equatable {
    case badEnvelope
    case badBase64
    case badNonce
    case ciphertextTooShort
    case authenticationFailed

    var errorDescription: String? {
        switch self {
        case .badEnvelope: return "The relay returned an envelope this app does not understand."
        case .badBase64: return "The envelope is not valid base64."
        case .badNonce: return "The envelope IV is not 12 bytes."
        case .ciphertextTooShort: return "The envelope ciphertext is too short."
        case .authenticationFailed: return "Decryption failed — the pairing key does not match this slot. Re-pair from the desktop widget."
        }
    }
}

enum PayloadCrypto {
    static let nonceLength = 12
    static let tagLength = 16

    /// Envelope → plaintext bytes (UTF-8 JSON of a PhonePayload).
    static func decrypt(envelope: Envelope, pairing: Pairing) throws -> Data {
        guard envelope.v == 1, let ivB64 = envelope.iv, let ctB64 = envelope.ct else {
            throw CryptoError.badEnvelope
        }
        guard let iv = Data(base64Encoded: ivB64, options: [.ignoreUnknownCharacters]),
              let ct = Data(base64Encoded: ctB64, options: [.ignoreUnknownCharacters]) else {
            throw CryptoError.badBase64
        }
        guard iv.count == nonceLength else { throw CryptoError.badNonce }
        guard ct.count >= tagLength else { throw CryptoError.ciphertextTooShort }

        let nonce: AES.GCM.Nonce
        do {
            nonce = try AES.GCM.Nonce(data: iv)
        } catch {
            throw CryptoError.badNonce
        }

        let body: Data = ct.dropLast(tagLength)
        let tag: Data = ct.suffix(tagLength)
        let box: AES.GCM.SealedBox
        do {
            box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: body, tag: tag)
        } catch {
            throw CryptoError.badEnvelope
        }

        let aad = Data(pairing.slotId.utf8)
        do {
            return try AES.GCM.open(box, using: pairing.encKey, authenticating: aad)
        } catch {
            throw CryptoError.authenticationFailed
        }
    }

    /// Convenience: envelope → decoded PhonePayload.
    static func decryptPayload(envelope: Envelope, pairing: Pairing) throws -> PhonePayload {
        let plaintext = try decrypt(envelope: envelope, pairing: pairing)
        return try JSONDecoder().decode(PhonePayload.self, from: plaintext)
    }
}
