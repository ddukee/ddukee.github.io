---
layout: post
title: Dubbo源码解析——服务暴露和引用
date: "2020-02-17 06:00:00 +0800"
categories: Dubbo
tags: java Dubbo rpc
published: true
---

## 前言

在远程调用过程中，远程调用的目标方法需要提供一个供远程调用方调用的入口；而发起远程调用的发起方也需要在本地创建一个代理对象来实现对远程方法的调用。Dubbo将提供远程调用目标的过程称为 **服务暴露**，而在调用发起方创建本地代理的过程称为 **服务引用**。

本文，我们将来分析Dubbo的服务暴露和引用的过程。在文章[《Dubbo源码解析——RPC实现原理》](/2020/02/01/Dubbo源码解析-RPC实现原理#服务引用和暴露)一文的中我们简要介绍了在RPC层面的服务引用和暴露，而本文我们将从应用层开始，自顶向下分析Dubbo完整的服务暴露和引用过程。

## 暴露服务

### 服务暴露过程

首先，我们来分析Dubbo暴露服务的过程。Dubbo服务暴露的大致流程如下：

![service_export](/assets/images/rpc_6-1.png){:width="50%" hight="50%"}

Dubbo提供了两种暴露服务的方式：

* 基于Java API的服务暴露
* 基于Spring容器的服务暴露

### 基于Java的服务暴露

基于Java的服务暴露方式，通过使用Dubbo的配置类`ServiceConfig`来实现服务的暴露。`ServiceConfig`的`export()`方法提供了服务暴露的起点。下面是一个简单的服务暴露的例子：

{% highlight java %}
UserService impl = new UserServiceImpl();

ApplicationConfig applicationConfig = new ApplicationConfig(); // 1
applicationConfig.setName("simpleProvider");
applicationConfig.setCompiler("jdk");

RegistryConfig registryConfig = new RegistryConfig(); // 2
registryConfig.setAddress("zookeeper://127.0.0.1:2181");

ProtocolConfig protocolConfig = new ProtocolConfig(); // 3
protocolConfig.setName("dubbo");
protocolConfig.setPort(20080);
protocolConfig.setTransporter("netty3");

ServiceConfig<UserService> serviceConfig = new ServiceConfig<>(); // 4
serviceConfig.setApplication(applicationConfig);
serviceConfig.setRegistry(registryConfig);
serviceConfig.setProtocol(protocolConfig);
serviceConfig.setInterface(UserService.class);
serviceConfig.setRef(impl);
serviceConfig.setVersion("1.0.0");

serviceConfig.export(); // 5
{% endhighlight %}

1. 通过`ApplicationConfig`设置应用的配置信息，包括应用的名称、自适应组件的编译器等。
2. 配置服务注册中心，这里使用了zookeeper作为服务注册中心。
3. 配置服务通过什么协议暴露，这里配置服务以dubbo协议在端口`20080`上进行服务暴露，关于dubbo协议的暴露过程可以参考`DubboProtocol`的`export()`方法和[《Dubbo源码解析——RPC实现原理》](/2020/02/01/Dubbo源码解析-RPC实现原理#服务引用和暴露)文章中的关于服务引用和暴露部分的内容。
4. 聚合需要被暴露的服务的信息。
5. 通过调用`export()`方法开始服务暴露。

上面是服务通过Java API进行服务暴露的例子，我们可以看到服务最终是通过`export()`进行暴露的。下面，我们将顺着`export()`方法来一窥服务暴露的整个过程。

#### export( )

在`ServiceConfig`的`export()`方法中主要做两件事：一、检查启动配置是否正确；二、判断是否需要暴露以及是否需要进行延迟暴露。

{% highlight java %}
public synchronized void export() {
    checkAndUpdateSubConfigs(); // 1

    if (!shouldExport()) { // 2
        return;
    }

    if (shouldDelay()) {
        DELAY_EXPORT_EXECUTOR.schedule(this::doExport, getDelay(), TimeUnit.MILLISECONDS); // 3
    } else {
        doExport(); // 4
    }
}

protected synchronized void doExport() { // 5
    if (unexported) {
        throw new IllegalStateException("The service " + interfaceClass.getName() + " has already unexported!");
    }
    if (exported) {
        return;
    }
    exported = true;

    if (StringUtils.isEmpty(path)) {
        path = interfaceName;
    }
    doExportUrls();
}
{% endhighlight %}

1. 检查服务暴露时配置的参数是否完整，包括默认参数的设置、注册中心配置检查（如果配置了注册中心的话）、被暴露的接口Class对象检查等。
2. 判断是否需要暴露服务，如果没有配置则默认暴露服务。
3. 判断是否需要延迟暴露，如果需要延迟暴露则将服务暴露过程打包成一个任务交由`ScheduledExecutorService`延迟执行。
4. 如果立即暴露，则调用`doExport()`进行服务暴露过程。
5. 在`doExport()`中检查当前的服务暴露状态，最终调用`doExportUrls`开始服务暴露。

下面我们来看下`doExportUrls()`的逻辑，在`doExportUrls()`中将会基于提供的注册中心配置进行服务的暴露。

{% highlight java %}
private void doExportUrls() {
    List<URL> registryURLs = loadRegistries(true); // 1
    for (ProtocolConfig protocolConfig : protocols) { // 2
        String pathKey = URL.buildKey(getContextPath(protocolConfig).map(p -> p + "/" + path).orElse(path), group, version);
        ProviderModel providerModel = new ProviderModel(pathKey, ref, interfaceClass);
        ApplicationModel.initProviderModel(pathKey, providerModel);
        doExportUrlsFor1Protocol(protocolConfig, registryURLs); // 3
    }
}
{% endhighlight %}

1. 基于注册中心的配置`RegistryConfig`来加载表示注册中心配置的注册URL。Dubbo中关于配置信息的传递都是基于URL来实现的。
2. 由于Dubbo支持同时对多个协议进行服务暴露，所以这个会基于配置的`ProtocolConfig`，在每个协议上逐个进行服务暴露。
3. 调用`doExportUrlsFor1Protocol`在单个协议上进行服务暴露。

通过`loadRegistries()`从`registryConfig`生成的注册中心URL格式如下：

![registry_url](/assets/images/rpc_6-2.png){:width="50%" hight="50%"}

在URL的 **schema** 使用`registry`表示这是一个注册中心的URL。URL的 **host** 表示注册中心的主机地址。注册中心的URL的 **path** 部分是`org.apache.dubbo.registry.RegistryService`，最后Dubbo的配置信息通过URL的 **query** 参数进行拼接。在拼接 **query** 参数的时候，除了将Dubbo的配置信息放到 **query** 参数上之外，对于注册URL还会把注册中心URL中的 **schema** 属性作为`registry`参数拼接到 **query** 中。比如在我们例子中会加上 `registry=zookeeper`。

我们上面例子中配置的`RegistryConfig`通过`loadRegistries()`会生成如下的注册URL：

{% highlight text %}
registry://127.0.0.1:2181/org.apache.dubbo.registry.RegistryService?application=simpleProvider&compiler=jdk&dubbo=2.0.2&pid=60377&registry=zookeeper&release=2.7.3&timestamp=1585009172197
{% endhighlight %}




### 基于Spring容器的暴露服务

## 服务引用

### 服务引用过程

### 基于Java的服务引用

### 基于Spring容器的引用服务

## 总结