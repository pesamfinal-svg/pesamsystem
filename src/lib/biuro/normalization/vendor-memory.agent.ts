// src/lib/biuro/normalization/vendor-memory.agent.ts
//
// Podagent Profili Dostawców (Vendor Dialect Memory per NIP)
// Pamięć Firestore: vendor_catalogs/{nip}/items/{item_hash}
// Czysta baza: przechowuje wyłącznie rzeczywiste reguły z Firestore (bez sztucznych danych).

import { db } from '@/lib/firebase/config';
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  getDocs,
  increment,
} from 'firebase/firestore';
import { VendorCatalogItem } from '@/types/biuro/vendorCatalog.types';

export class VendorMemoryAgent {
  private static localCache: Map<string, VendorCatalogItem> = new Map();

  /**
   * Oczyszcza nazwę towaru do znormalizowanego klucza słownikowego
   */
  static cleanKey(rawName: string): string {
    return rawName
      .toUpperCase()
      .replace(/[ąćęłńóśźż]/g, (match) => {
        const map: Record<string, string> = {
          'ą': 'A', 'ć': 'C', 'ę': 'E', 'ł': 'L', 'ń': 'N',
          'ó': 'O', 'ś': 'S', 'ź': 'Z', 'ż': 'Z'
        };
        return map[match] || match;
      })
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .substring(0, 80);
  }

  /**
   * Generuje unikalny klucz w cache i Firestore
   */
  static createCacheKey(vendorNip: string, cleanKey: string): string {
    const sanitizedNip = (vendorNip || 'UNKNOWN').replace(/\D/g, '');
    return `${sanitizedNip}::${cleanKey}`;
  }

  /**
   * Wyszukuje pozycję w pamięci danego NIP-u (najpierw Cache w RAM, potem Firestore)
   */
  static async lookupItem(vendorNip: string, rawName: string): Promise<VendorCatalogItem | null> {
    const cleanLookupKey = this.cleanKey(rawName);
    const sanitizedNip = (vendorNip || '').replace(/\D/g, '');
    const cacheKey = this.createCacheKey(sanitizedNip, cleanLookupKey);

    // 1. Sprawdzenie szybkiej pamięci lokalnej (Fast RAM Cache)
    if (this.localCache.has(cacheKey)) {
      const item = this.localCache.get(cacheKey)!;
      item.usage_count += 1;
      item.last_used_at = new Date().toISOString();
      return item;
    }

    // 2. Sprawdzenie kolekcji Firestore: vendor_catalogs/{nip}/items/{cleanLookupKey}
    try {
      if (sanitizedNip) {
        const itemDocRef = doc(db, 'vendor_catalogs', sanitizedNip, 'items', cleanLookupKey);
        const snapshot = await getDoc(itemDocRef);
        if (snapshot.exists()) {
          const data = snapshot.data() as VendorCatalogItem;
          this.localCache.set(cacheKey, data);
          updateDoc(itemDocRef, {
            usage_count: increment(1),
            last_used_at: new Date().toISOString()
          }).catch(() => {});
          return data;
        }
      }
    } catch (err) {
      console.warn('[VendorMemoryAgent] Firestore lookup warning:', err);
    }

    return null;
  }

  /**
   * Zapisuje nowo poznaną regułę w Firestore oraz w cache RAM
   */
  static async saveLearnedRule(item: VendorCatalogItem, vendorName?: string): Promise<void> {
    const sanitizedNip = (item.vendor_nip || '').replace(/\D/g, '');
    const cleanLookupKey = item.clean_lookup_key || this.cleanKey(item.vendor_raw_name);
    const cacheKey = this.createCacheKey(sanitizedNip, cleanLookupKey);

    const enrichedItem: VendorCatalogItem = {
      ...item,
      clean_lookup_key: cleanLookupKey,
      vendor_nip: sanitizedNip,
      usage_count: item.usage_count || 1,
      last_used_at: new Date().toISOString(),
    };

    // Zapis w pamięci RAM
    this.localCache.set(cacheKey, enrichedItem);

    // Zapis w Firestore
    try {
      if (sanitizedNip) {
        // Upewnij się, że dokument nadrzędny dostawcy istnieje (do listowania dostawców)
        const vendorDocRef = doc(db, 'vendor_catalogs', sanitizedNip);
        await setDoc(vendorDocRef, {
          nip: sanitizedNip,
          ...(vendorName ? { name: vendorName } : {}),
          updated_at: new Date().toISOString(),
        }, { merge: true });

        const itemDocRef = doc(db, 'vendor_catalogs', sanitizedNip, 'items', cleanLookupKey);
        await setDoc(itemDocRef, enrichedItem, { merge: true });
      }
    } catch (err) {
      console.warn('[VendorMemoryAgent] Failed to persist learned rule in Firestore:', err);
    }
  }

  /**
   * Pobiera wszystkie rzeczywiste reguły z Firestore (dla danego NIP-u lub wszystkich dostawców)
   */
  static async fetchAllFromFirestore(vendorNip?: string): Promise<{
    vendors: Array<{ nip: string; name?: string }>;
    rules: VendorCatalogItem[];
  }> {
    const sanitizedFilterNip = vendorNip ? vendorNip.replace(/\D/g, '') : null;
    const vendors: Array<{ nip: string; name?: string }> = [];
    const rules: VendorCatalogItem[] = [];

    try {
      const vendorsSnap = await getDocs(collection(db, 'vendor_catalogs'));
      for (const vDoc of vendorsSnap.docs) {
        const vData = vDoc.data();
        const nip = vDoc.id;
        vendors.push({ nip, name: vData.name });

        if (!sanitizedFilterNip || nip === sanitizedFilterNip) {
          const itemsSnap = await getDocs(collection(db, 'vendor_catalogs', nip, 'items'));
          for (const iDoc of itemsSnap.docs) {
            const rule = iDoc.data() as VendorCatalogItem;
            rules.push(rule);
            this.localCache.set(this.createCacheKey(nip, rule.clean_lookup_key), rule);
          }
        }
      }
    } catch (err) {
      console.warn('[VendorMemoryAgent] Firestore fetchAll warning:', err);
    }

    return { vendors, rules };
  }

  /**
   * Usuwa konkretną regułę dialektu z Firestore i z cache RAM
   */
  static async deleteRule(vendorNip: string, cleanLookupKey: string): Promise<void> {
    const sanitizedNip = (vendorNip || '').replace(/\D/g, '');
    const cacheKey = this.createCacheKey(sanitizedNip, cleanLookupKey);
    this.localCache.delete(cacheKey);

    if (sanitizedNip && cleanLookupKey) {
      const itemDocRef = doc(db, 'vendor_catalogs', sanitizedNip, 'items', cleanLookupKey);
      await deleteDoc(itemDocRef);

      // Jeśli dostawca nie ma już żadnych pozycji, usuń też dokument nadrzędny
      const remaining = await getDocs(collection(db, 'vendor_catalogs', sanitizedNip, 'items'));
      if (remaining.empty) {
        await deleteDoc(doc(db, 'vendor_catalogs', sanitizedNip));
      }
    }
  }
}
