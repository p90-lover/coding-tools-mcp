package main

/*
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
	void* ptr;
	size_t len;
} cliproxy_buffer;

typedef int (*cliproxy_host_call_fn)(void*, char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_host_free_fn)(void*, size_t);

typedef struct {
	uint32_t abi_version;
	void* host_ctx;
	cliproxy_host_call_fn call;
	cliproxy_host_free_fn free_buffer;
} cliproxy_host_api;

typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);

typedef struct {
	uint32_t abi_version;
	cliproxy_plugin_call_fn call;
	cliproxy_plugin_free_fn free_buffer;
	cliproxy_plugin_shutdown_fn shutdown;
} cliproxy_plugin_api;

extern int cliproxy_plugin_call(char*, uint8_t*, size_t, cliproxy_buffer*);
extern void cliproxy_plugin_free(void*, size_t);
extern void cliproxy_plugin_shutdown(void);
*/
import "C"

import (
	"unsafe"
)

const abiVersion = 1

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(_ *C.cliproxy_host_api, plugin *C.cliproxy_plugin_api) C.int {
	if plugin == nil {
		return 1
	}
	plugin.abi_version = abiVersion
	plugin.call = (C.cliproxy_plugin_call_fn)(C.cliproxy_plugin_call)
	plugin.free_buffer = (C.cliproxy_plugin_free_fn)(C.cliproxy_plugin_free)
	plugin.shutdown = (C.cliproxy_plugin_shutdown_fn)(C.cliproxy_plugin_shutdown)
	return 0
}

//export cliproxy_plugin_call
func cliproxy_plugin_call(method *C.char, request *C.uint8_t, requestLen C.size_t, response *C.cliproxy_buffer) C.int {
	if response != nil {
		response.ptr = nil
		response.len = 0
	}
	if method == nil {
		writeCResponse(response, errorEnvelope("invalid_method", "method is required"))
		return 1
	}

	methodName := C.GoString(method)
	var requestBytes []byte
	if request != nil && requestLen > 0 {
		requestBytes = C.GoBytes(unsafe.Pointer(request), C.int(requestLen))
	}

	raw, code := handlePluginCall(methodName, requestBytes)
	writeCResponse(response, raw)
	return C.int(code)
}

//export cliproxy_plugin_free
func cliproxy_plugin_free(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxy_plugin_shutdown
func cliproxy_plugin_shutdown() {}

func writeCResponse(response *C.cliproxy_buffer, raw []byte) {
	if response == nil || len(raw) == 0 {
		return
	}
	ptr := C.malloc(C.size_t(len(raw)))
	if ptr == nil {
		return
	}
	C.memcpy(ptr, unsafe.Pointer(&raw[0]), C.size_t(len(raw)))
	response.ptr = ptr
	response.len = C.size_t(len(raw))
}
