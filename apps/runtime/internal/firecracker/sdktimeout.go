package firecracker

import "os"

// sdkRequestTimeoutEnv is the variable firecracker-go-sdk v1.0.0 reads, once per
// client, for its per-request API deadline. Its default is 500 ms.
const sdkRequestTimeoutEnv = "FIRECRACKER_GO_SDK_REQUEST_TIMEOUT_MILLISECONDS"

// defaultSDKRequestTimeoutMillis replaces the SDK's 500 ms. Attaching a fresh
// 96 GiB thin snapshot as the root drive (PUT /drives/rootfs) has Firecracker
// open the device, and under host disk load that open took longer than 500 ms:
// on ubuntu0 every Attempt from 17:31 to 18:12 UTC on 2026-11-10 failed with
// `Put "http://localhost/drives/rootfs": context deadline exceeded`. The boot as
// a whole is still bounded by the Attempt's own context.
const defaultSDKRequestTimeoutMillis = "10000"

// ensureSDKRequestTimeout sets the SDK's request deadline unless the operator
// set one. It must run before fc.NewMachine, which builds the client.
func ensureSDKRequestTimeout() {
	if _, set := os.LookupEnv(sdkRequestTimeoutEnv); !set {
		_ = os.Setenv(sdkRequestTimeoutEnv, defaultSDKRequestTimeoutMillis)
	}
}
