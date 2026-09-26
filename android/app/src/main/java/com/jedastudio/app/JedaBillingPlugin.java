package com.jedastudio.app;

import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetailsResponseListener;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;

@CapacitorPlugin(name = "JedaBilling")
public class JedaBillingPlugin extends Plugin implements PurchasesUpdatedListener {
    private BillingClient client;
    private PluginCall purchaseCall;

    @PluginMethod
    public void getProducts(PluginCall call) {
        List<String> ids = new ArrayList<>();
        JSArray requested = call.getArray("productIds");
        if (requested != null) {
            try {
                for (int index = 0; index < requested.length(); index++) {
                    Object value = requested.get(index);
                    if (!(value instanceof String)) { call.reject("Daftar produk langganan tidak valid."); return; }
                    ids.add((String) value);
                }
            } catch (org.json.JSONException error) { call.reject("Daftar produk langganan tidak valid."); return; }
        }
        if (ids.isEmpty() || ids.size() > 10) {
            call.reject("Daftar produk langganan tidak valid.");
            return;
        }
        connect(call, () -> queryProducts(ids, call, (products) -> {
            JSArray result = new JSArray();
            for (ProductDetails product : products) result.put(productJson(product));
            call.resolve(new JSObject().put("products", result));
        }));
    }

    @PluginMethod
    public void purchase(PluginCall call) {
        if (purchaseCall != null) {
            call.reject("Selesaikan pembelian yang sedang berjalan terlebih dahulu.");
            return;
        }
        String productId = call.getString("productId");
        String userId = call.getString("userId");
        if (productId == null || !productId.matches("[A-Za-z0-9._-]{1,100}") || userId == null || userId.length() > 128) {
            call.reject("Produk atau akun tidak valid.");
            return;
        }
        connect(call, () -> queryProducts(java.util.Collections.singletonList(productId), call, (products) -> {
            if (products.isEmpty()) {
                call.reject("Produk langganan tidak tersedia di Google Play.");
                return;
            }
            ProductDetails product = products.get(0);
            List<ProductDetails.SubscriptionOfferDetails> offers = product.getSubscriptionOfferDetails();
            if (offers == null || offers.isEmpty()) {
                call.reject("Penawaran langganan untuk produk ini belum tersedia.");
                return;
            }
            String obfuscatedAccountId;
            try { obfuscatedAccountId = sha256(userId); }
            catch (Exception error) { call.reject("Akun tidak dapat disiapkan untuk pembelian.", error); return; }
            BillingFlowParams.ProductDetailsParams details = BillingFlowParams.ProductDetailsParams.newBuilder()
                .setProductDetails(product)
                .setOfferToken(offers.get(0).getOfferToken())
                .build();
            BillingFlowParams params = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(java.util.Collections.singletonList(details))
                .setObfuscatedAccountId(obfuscatedAccountId)
                .build();
            purchaseCall = call;
            call.setKeepAlive(true);
            BillingResult result = client.launchBillingFlow(getActivity(), params);
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                purchaseCall = null;
                call.setKeepAlive(false);
                call.reject("Google Play tidak dapat membuka pembayaran: " + result.getDebugMessage());
            }
        }));
    }

    @PluginMethod
    public void restore(PluginCall call) {
        connect(call, () -> client.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder().setProductType(BillingClient.ProductType.SUBS).build(),
            (result, purchases) -> {
                if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    call.reject("Pembelian Google Play belum dapat diperiksa.");
                    return;
                }
                call.resolve(new JSObject().put("purchases", purchasesJson(purchases)));
            }
        ));
    }

    @Override
    public void onPurchasesUpdated(BillingResult result, List<Purchase> purchases) {
        PluginCall call = purchaseCall;
        purchaseCall = null;
        if (call == null) {
            if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && purchases != null) {
                notifyListeners("purchaseUpdated", new JSObject().put("purchases", purchasesJson(purchases)));
            }
            return;
        }
        call.setKeepAlive(false);
        if (result.getResponseCode() == BillingClient.BillingResponseCode.OK && purchases != null) {
            call.resolve(new JSObject().put("purchases", purchasesJson(purchases)));
        } else if (result.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            call.resolve(new JSObject().put("cancelled", true));
        } else {
            call.reject("Pembelian Google Play gagal: " + result.getDebugMessage());
        }
    }

    private void connect(PluginCall call, Runnable ready) {
        if (client == null) {
            client = BillingClient.newBuilder(getContext())
                .setListener(this)
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableAutoServiceReconnection()
                .build();
        }
        if (client.isReady()) { ready.run(); return; }
        client.startConnection(new com.android.billingclient.api.BillingClientStateListener() {
            @Override public void onBillingSetupFinished(BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) ready.run();
                else call.reject("Layanan Google Play belum siap: " + result.getDebugMessage());
            }
            @Override public void onBillingServiceDisconnected() { }
        });
    }

    private interface ProductsCallback { void done(List<ProductDetails> products); }

    private void queryProducts(List<String> ids, PluginCall call, ProductsCallback callback) {
        List<QueryProductDetailsParams.Product> products = new ArrayList<>();
        for (String id : ids) {
            if (id == null || !id.matches("[A-Za-z0-9._-]{1,100}")) {
                call.reject("ID produk Google Play tidak valid.");
                return;
            }
            products.add(QueryProductDetailsParams.Product.newBuilder()
                .setProductId(id).setProductType(BillingClient.ProductType.SUBS).build());
        }
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder().setProductList(products).build();
        client.queryProductDetailsAsync(params, (result, details) -> {
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                call.reject("Produk Google Play gagal dimuat: " + result.getDebugMessage());
                return;
            }
            callback.done(details.getProductDetailsList());
        });
    }

    private JSObject productJson(ProductDetails details) {
        JSObject item = new JSObject();
        item.put("productId", details.getProductId());
        item.put("title", details.getTitle());
        item.put("description", details.getDescription());
        List<ProductDetails.SubscriptionOfferDetails> offers = details.getSubscriptionOfferDetails();
        if (offers != null && !offers.isEmpty()) {
            List<ProductDetails.PricingPhase> phases = offers.get(0).getPricingPhases().getPricingPhaseList();
            if (!phases.isEmpty()) {
                ProductDetails.PricingPhase phase = phases.get(phases.size() - 1);
                item.put("price", phase.getFormattedPrice());
                item.put("billingPeriod", phase.getBillingPeriod());
            }
        }
        return item;
    }

    private JSArray purchasesJson(List<Purchase> purchases) {
        JSArray result = new JSArray();
        for (Purchase purchase : purchases) {
            JSObject item = new JSObject();
            item.put("purchaseToken", purchase.getPurchaseToken());
            item.put("productIds", new JSArray(purchase.getProducts()));
            item.put("purchaseState", purchase.getPurchaseState());
            item.put("isAcknowledged", purchase.isAcknowledged());
            result.put(item);
        }
        return result;
    }

    private String sha256(String value) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(value.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(64);
        for (byte part : digest) hex.append(String.format(java.util.Locale.ROOT, "%02x", part));
        return hex.toString();
    }
}
