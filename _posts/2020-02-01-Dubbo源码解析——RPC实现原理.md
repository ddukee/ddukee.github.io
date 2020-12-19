---
layout: post
title: Dubbo源码解析——RPC实现原理
date: "2020-02-01 00:33:00 +0800"
categories: Dubbo
tags: java Dubbo rpc
published: true
---

## 前言

Dubbo是阿里开源的一款用于服务治理的RPC通信框架。纯Java语言编写，开源以后被很多公司作为技术栈的一部分用于应用开发。

Dubbo除了支持最基本的RPC功能之外，还提供了服务治理的能力，包括：服务发现、服务降级、服务路由、集群容错。本文将重点关注Dubbo的RPC的实现，通过分析源码来了解Dubbo的RPC功能是如何实现的。

由于Dubbo中服务调用的过程有些复杂，涉及到注册中心、负载均衡、序列化以及远程通信等模块，而这些模块并不是一个RPC框架所必须的。一方面不希望源码分析过程过多的陷入细节中，从而失去对整个Dubbo RPC调用过程的全局把握；另一方面也是出于篇幅考虑，一篇文章很难兼顾细节和整体，所以本文将只关注RPC的实现过程。

*注意：本文分析和引用的源码基于Dubbo的2.7.3版本，本文假设读者有Dubbo的使用经验*

## Dubbo概览

### 架构

![dubbo](/assets/images/rpc_1-0.png){:width="60%" hight="60%"}

这是Dubbo中各个角色的交互图，我们可以看到在Dubbo中不同的组件有不同的角色：服务提供者Provider、服务消费者Consumer、注册中心Registry、服务运行容器Container以及监控中心Monitor。这些角色在服务启动过程中会按照如下的过程交互：

1. 容器Container启动服务提供者和消费者。
2. 服务提供者Provider启动并向注册中心Registry注册服务。
3. 服务消费者Consumer启动并从注册中心Registry订阅服务。
4. 服务消费者Consumer向服务提供者Provider发起请求。
5. 服务提供者和消费者同步监控中心统计信息。

在实现上Dubbo采用了分层架构，类似于网络的多层架构，Dubbo通过分层架构将RPC服务中不同领域的问题抽象到不同的层中，达到封装和扩展的目的。

![arch](/assets/images/rpc_1-2.png){:width="30%" hight="30%"}

Dubbo的分层架构分的很细，总共可以分为10层，从上到下依次是：Service、Config、Proxy、Registry、Cluster、Monitor、Protocol、Exchange、Transport、Serialize。

通过分层以后，各层模块的职责分明，依赖关系明确。比如exchange层的目的是封装请求响应模式，封装网络请求的request和response语义，在exchange层之上不需要关心网络的通信细节。同时，通过在各层之前定义良好的接口，可以进行独立扩展，Dubbo的可扩展性也得益于分层架构。

### 项目结构
在开始分析Dubbo源码之前，我们先看下Dubbo项目的结构。Dubbo通过Maven进行构建，整个项目包含了多个模块（Module）。

{% highlight text %}
.
├── dubbo-cluster
├── dubbo-common
├── dubbo-config
├── dubbo-container
├── dubbo-monitor
├── dubbo-plugin
├── dubbo-registry
├── dubbo-remoting
├── dubbo-rpc
└── pom.xml
{% endhighlight %}

dubbo-common
: 公共逻辑模块，包括Util类和通用模型。

dubbo-config
: 配置模块，是Dubbo对外的API，用户通过Config使用Dubbo，隐藏Dubbo所有细节。

dubbo-monitor
: 监控模块，用于统计服务调用次数，调用时间的，调用链跟踪的服务。

dubbo-registry
: 注册中心模块，基于注册中心下发地址的集群方式，以及对各种注册中心的抽象。

dubbo-cluster
: 集群模块，将多个服务提供方伪装为一个提供方，里面包括：负载均衡, 容错，路由等。

dubbo-rpc
: 远程调用模块，抽象各种协议，以及动态代理，只包含一对一的调用，不关心集群的管理。

dubbo-remoting
: 远程通讯模块，这个模块只是对Dubbo协议的实现，如果RPC不用Dubbo协议就用不到这个模块。

dubbo-monitor
: 监控模块，监控服务的调用次数和调用时间。

dubbo-container
: 容器模块，一个Standlone的容器，以简单的Main加载Spring启动。如果服务通常不需要Tomcat/JBoss等Web容器的特性，可以不依赖Web容器而只依赖dubbo-container模块提供的容器启动服务。

这些模块通过分层架构的方式组合在一起，各司其职组成完整的Dubbo服务。其中模块`dubbo-rpc`提供了RPC基础的功能。通过`dubbo-rpc`模块我们可以直接实现透明的点对点RPC调用，而关于服务治理相关的实现，比如服务注册发现，负载均衡则是在`dubbo-rpc`的基础上添加的功能模块，在模块`dubbo-registry`和`dubbo-cluster`中实现。本文，我们先从Dubbo的RPC实现开始，逐步分析Dubbo的实现原理。

## RPC基本原理
RPC[^1]是 **远程调用（Remote Procedure Call）** 的缩写。当一个程序调用一个过程（方法）的时候，一般这个被调用方和调用者是在同一个内存空间（同一个进程）里面的，而远程过程调用（RPC）则是一个方法像调用自己内存空间中的一个方法一样跨内存空间调用另外一个进程中的方法，一般这个调用过程中会跨机器，需要网络通信。

![dubbo_rpc](/assets/images/rpc_1-1.png){:width="60%" hight="60%"}

虽然 **Dubbo** 是Java世界中的一个RPC框架，但是RPC本身的概念是和语言无关的，RPC最早在过程式语言中就已经存在了。在面向对象（OO）中，RPC又叫 **远程方法调用（RMI）**，Java基于JVM实现了一个RMI框架。

RPC和Linux中的管道（pipe）一样，也是进程间通信机制（IPC）的一种，在两个具有不同内存空间的进程之间进行数据交换。而数据交换的过程可以是在一台物理机器上，也可以跨物理机器，通过网络通信实现数据的交换。

一个远程过程调用（RPC）框架一般需要解决两个问题：
1. 数据怎么传递
2. 如何实现像调用本地方法一样调用远程方法

第一个问题说的就是进程间通信的问题，涉及到IO和通信协议。Java有很多通信框架可以选择，比如Netty、Mina、Grizzly等。通信协议是语言无关的，比如Dubbo支持HTTP协议，RMI协议或者使用Dubbo内置的 **dubbo** 协议。

第二个问题则一般和语言相关，为了达到像调用本地方法一样调用远程方法的效果，一般需要采用 **代理** 的方式屏蔽底层通信细节，让调用者以为在调用本地的方法，实际上是伪装成本地方法的代理在处理远程通信的细节。不同的语言实现代理的方式因语言特性而异，比如Java语言是一种运行时链接的语言，支持动态代理，所以可以很好地处理屏蔽远程方法调用的问题。Dubbo确实就是这么做的，利用Java动态代理的特性，服务的暴露者（Provider）只需要暴露服务，使用服务的那一方（Consumer）引用Jar包中定义接口的接口，通过接口调用接口中的方法就可以实现远程过程调用，而远程过程调用的细节对使用者来说就像黑盒。

接下来，我们将一窥这个黑盒子的内部构造。

## dubbo-rpc模块
`dubbo-rpc`是Dubbo中的核心模块，Dubbo通过`dubbo-rpc`模块可以实现透明的点对点远程过程调用。单独使用`dubbo-rpc`模块就可以实现一个非透明的RPC调用。

`dubbo-rpc`模块中包含了多个包，其中`dubbo-rpc-api`包定义了一个具体的RPC实现需要实现的接口。通过明确定义RPC实现的接口，为自定义扩展提供了统一的API层。Dubbo的实现高度可扩展。

我们前面提到了，远程过程调用可能需要跨网络进行方法调用。如果数据需要进行网络通信，那么就需要一种组织通信信息格式的约定，也就是我们常说的网络通信协议（protocol）（注意，这里的protocol和Dubbo中的`Protocol`是不一样，不要混淆）。进行网络通信的协议，比如我们用的最多的HTTP协议，就可以用来做RPC通信层的网络协议，除此之外Dubbo自己也实现了一个二进制协议：**dubbo协议**。

Dubbo支持协议扩展，这些扩展被放在`dubbo-rpc`模块的各个包中，比如：`dubbp-rpc-dubbo`包中包含了 **dubbo协议** 的扩展，`dubbo-rpc-http`包是HTTP协议实现的RPC扩展。`dubbo-rpc`模块中总共包含了13种不同协议实现的RPC扩展：

| 包 | 描述 |
|----+-----|
| dubbp-rpc-dubbo | Dubbo协议实现的RPC扩展 |
| dubbo-rpc-hessian | Hessian协议实现的RPC扩展 |
| dubbo-rpc-http | HTTP协议实现的RPC扩展 |
| dubbo-rpc-injvm | JVM内部本地实现的RPC扩展 |
| dubbo-rpc-jsonrpc | jsonrpc实现的RPC扩展  |
| dubbo-rpc-memcached | 准确的说它不是一个真正意义上的RPC扩展，只是提供了一个支持RPC语义的memcached客户端 |
| dubbo-rpc-redis | 和dubbp-rpc-memcached一样，只不过面向的是Redis的客户端 |
| dubbo-rpc-native-thrift | 基于Apache Thrift实现的RPC扩展 |
| dubbo-rpc-thrift | 已经废弃，被dubbo-rpc-native-thrift替代 |
| dubbo-rpc-rest | Restful风格的RPC扩展，基于HTTP协议 |
| dubbo-rpc-rmi | 基于JVM的RMI实现的RPC扩展 |
| dubbo-rpc-webservice | 基于Webservice实现的RPC扩展 |
| dubbo-rpc-xml | 和dubbo-rpc-jsonrpc一样，是一个基于xmlrpc实现的RPC扩展 |

我们可以基于技术栈的要求选用不同的RPC实现。官方建议如果是短报文的请求，dubbo协议是比较推荐的选择。下面，我们就以dubbo协议的RPC实现`dubbo-rpc-dubbo`为例，来看下Dubbo是如何对远程过程调用进行抽象的。

## 实现远程方法调用的原理
前面介绍RPC基本原理的时候我们已经提到：远程过程调用通过在本地模拟一个远程方法（在RPC中一般称之为存根Stub，不过在Dubbo中Stub是一类特殊的方法，存在在服务提供方提供的jar包中，可以在服务消费方调用该服务的时候被本地JVM加载并执行），使得程序在调用该方法的时候就像调用本地方法一样，把调用过程中涉及到的网络通信等细节对应用层屏蔽了。Dubbo作为一个RPC框架，自然也需要将这些通信细节屏蔽掉，那么Dubbo是如何做的呢？

### Invoker

我们知道RPC本质上就是一个方法调用过程，只是发起方法调用的请求是在JVM内部还是跨了网络，为了将方法调用的概念抽象出来，Dubbo引入了 **Invoker** 。

{% highlight java %}
package org.apache.dubbo.rpc;

public interface Invoker<T> extends Node {
    Class<T> getInterface();
    Result invoke(Invocation invocation) throws RpcException;
}
{% endhighlight %}

`Invoker`在Dubbo中被定义为一个接口，是Dubbo中的一个重要概念和抽象。方法调用过程都是围绕着`Invoker`展开的。`Invoker`中定义了一个`invoke()`方法用于表示方法调用，`getInterface()`方法用于表示当前`Invoker`是从哪个接口转换过来的。

我们知道，在Java中方法（Method）表示的是类（接口）的一个行为，所以调用一个对象的方法在面向对象中其实就是对一个对象发起一个请求的过程。在Java语言中，我们调用和执行方法的功能是语言本身的特性赋予的：编程语言中的调用方法（过程），在底层实现上其实就是一系列的跳转指令，而这些复杂底层细节都由编译器屏蔽了，在语言层面只提供了抽象的方法调用操作，程序员在不用关心底层细节的情况下就可以完成方法调用。

但是当调用的目标不是在JVM内部而是在另外一个JVM（另外一个进程）中的时候，和原先本地调用一个方法相比不再是简单的跳转指令能完成的（处于不同的进程空间），Java编译器不能在编译期生成跳转地址，数据也不能通过本地内存共享。所以为了让程序员感知不到远程调用的底层细节，关于调用的细节需要在Dubbo框架中自己封装并实现。现在，如何将方法调用和跨网络请求之间进行转换将是RPC实现者需要考虑的问题。

Dubbo在解决这个问题的时候，通过`Invoker`接口将方法调用过程进行了抽象，实现了原先Java语言层面支持的方法调用方式和`Invoker.invoke()`之间的转换。方法调用的上下文信息被存储在`Invocation`中，包括方法名称，参数等信息。

![Invoker](/assets/images/rpc_1-3.png){:width="60%" hight="60%"}

当引入`Invoker`以后，调用一个类（接口）的任意一个方法的行为就可以转换成调用`Invoker`的`invoke()`方法，这就使得原先在代码层面对不同的类调用不同方法的方式转换成统一的调用逻辑，这类似于我们熟悉的Java中对方法进行反射（Reflection）拿到`Method`对象并执行它的`invoke`方法。通过这种方式将语言层面的静态调用过程转换成动态调用的过程。

在方法调用和`Invoker.invoke()`之间转换的时候，我们需要分两个角度考虑：

1. 服务提供方。对服务提供方来说，由于它提供了RPC中方法调用的目标，所以在服务提供方一侧，需要将`Invoker.invoke()`转换成调用某个对象的某个方法。
2. 服务消费方。对于服务消费方来说，它是请求的发起方，所以在代码层面发起的方法调用需要转换成`Invoker.invoke()`形式的调用。

![invoker2method](/assets/images/rpc_1-4.png){:width="60%" hight="60%"}

为了实现上面提到的两个转换过程，在Java技术体系中我们需要用到两种的技术：

1. 反射（Reflection）
2. 动态代理（Dynamic Proxy）

### Invoker向方法调用转换

首先，在服务提供方一侧我们需要将从网络上收到的请求转换成对某个对象中某个方法的调用。在Java中，如果我们想要在运行时调用某个方法，我们可以利用Java的 **反射机制（Reflection）** 来实现。我们只要知道类的全限定名和方法名称，我们就可以用类的全限定名通过`Class.forName()`拿到对应的类对象，然后通过`Class.getMethod()`方法获取到对应名字方法的`Method`对象，之后就可以用这个拿到的`Method`对象进行方法调用了。

Dubbo用的就是这种思路来完成`Invoker`向方法调用的转换的。Dubbo将一个需要暴露的接口封装成`Invoker`以后，利用反射机制将`Invoker`的`invoke()`调用委托给了`Method`对象的`invoke()`调用。向`Invoker`的转换逻辑是通过`org.apache.dubbo.rpc.ProxyFactory`中的`getInvoker()`方法来完成的。

{% highlight java %}
@SPI("javassist")
public interface ProxyFactory {
    /* 省略 */

    @Adaptive({PROXY_KEY})
    <T> Invoker<T> getInvoker(T proxy, Class<T> type, URL url) throws RpcException;
}
{% endhighlight %}

`ProxyFactory`是一个抽象工厂接口，在Dubbo中用于实现`Invoker`和方法调用的转换。当需要将`Invoker`转换成方法调用的时候，就用到了`ProxyFactory`中的`getInvoker()`方法。

在Dubbo的实现中，`ProxyFactory`接口的实现类有两个，分别是基于 **JDK** 和 **javassist**[^3]。这两个方式都用到了反射机制来获取类和方法的运行时信息，但是在实现调用逻辑上有些区别：`JdkProxyFactory`直接用了Java的方式机制来完成目标方法的调用，而`JavassistProxyFactory`则是通过动态生成调用目标方法代码的方式来实现的。下面我们先来看下`JdkProxyFactory`的实现方式：

{% highlight java %}
// JDK实现
public class JdkProxyFactory extends AbstractProxyFactory {
    ...
    ...
    @Override
    public <T> Invoker<T> getInvoker(T proxy, Class<T> type, URL url) {
        return new AbstractProxyInvoker<T>(proxy, type, url) {
            @Override
            protected Object doInvoke(T proxy, String methodName,
                                      Class<?>[] parameterTypes,
                                      Object[] arguments) throws Throwable {
                Method method = proxy.getClass().getMethod(methodName, parameterTypes);
                return method.invoke(proxy, arguments);
            }
        };
    }
}
{% endhighlight %}

在基于Java反射的实现中，在`getInvoker()`中会创建一个继承了`AbstractProxyInvoker`的匿名内部类，然后在匿名内部类的`doInvoke()`实现中调用通过反射获取到的`Method`对象中的`invoke()`方法。 

{% highlight java %}
public abstract class AbstractProxyInvoker<T> implements Invoker<T> {
  @Override
  public Result invoke(Invocation invocation) throws RpcException {
      try {
          // 调用具体的invoke逻辑
          Object value = doInvoke(proxy, invocation.getMethodName(), invocation.getParameterTypes(), invocation.getArguments());
          CompletableFuture<Object> future = wrapWithFuture(value, invocation);
          AsyncRpcResult asyncRpcResult = new AsyncRpcResult(invocation);
          future.whenComplete((obj, t) -> {
              ...
          });
          return asyncRpcResult;
      } catch (InvocationTargetException e) {
          ...
      } catch (Throwable e) {
          ...
      }
  }
}
{% endhighlight %}

`AbstractProxyInvoker`实现了`Invoker`接口，是一个抽象类。在`AbstractProxyInvoker`中实现了`invoke()`的主逻辑，然后通过 **模板方法模式（Template pattern）**[^2] 将具体的调用逻辑通过`doInvoke()`方法留给具体的实现来完成。

下面我们来看下`JavassistProxyFactory`的`getInvoker()`实现。

{% highlight java %}
// javassist实现
public class JavassistProxyFactory extends AbstractProxyFactory {
    ...
    ...
    @Override
    public <T> Invoker<T> getInvoker(T proxy, Class<T> type, URL url) {
        final Wrapper wrapper = Wrapper.getWrapper(proxy.getClass().getName().indexOf('$') < 0 ? proxy.getClass() : type);
        // 通过匿名内部类创建Invoker的子类
        return new AbstractProxyInvoker<T>(proxy, type, url) {
            @Override
            protected Object doInvoke(T proxy, String methodName,
                                      Class<?>[] parameterTypes,
                                      Object[] arguments) throws Throwable {
                return wrapper.invokeMethod(proxy, methodName, parameterTypes, arguments);
            }
        };
    }
}
{% endhighlight %}

`JavassistProxyFactory`在实现`getInvoker()`的时候相对`JdkProxyFactory`的实现版本要稍微复杂一些，它没有直接用反射获取`Method`对象，而是通过`Wrapper.getWrapper()`对目标对象动态生成了一个`Wrapper`包装类，然后在`doInvoke()`中通过调用`Wrapper`的`invokeMethod()`方法将调用请求委托给真正的目标对象，而`invokeMethod()`方法的代码则是在运行时基于反射提供的信息动态生成的。下面是`Wrapper`的`getWrapper()`方法的实现：

{% highlight java %}
public static Wrapper getWrapper(Class<?> c) {
    while (ClassGenerator.isDynamicClass(c)) // can not wrapper on dynamic class.
    {
        c = c.getSuperclass();
    }

    if (c == Object.class) {
        return OBJECT_WRAPPER;
    }

    Wrapper ret = WRAPPER_MAP.get(c);
    if (ret == null) {
        ret = makeWrapper(c);
        WRAPPER_MAP.put(c, ret);
    }
    return ret;
}
{% endhighlight %}

`Wrapper`的`getWrapper()`方法利用`makeWrapper()`生成了一个`Wrapper`对象，在`makeWrapper()`内部则是利用`ClassGenerator`动态生成了一个`Wrapper`子类并覆写了`invokeMethod()`方法。`ClassGenerator`动态生成类的能力用到了 **javassist** 框架的字节码生成功能。

{% highlight java %}
private static Wrapper makeWrapper(Class<?> c) {
  /* 代码生成逻辑省略 */
  ...
  
  StringBuilder c1 = new StringBuilder("public void setPropertyValue(Object o, String n, Object v){ ");
  StringBuilder c2 = new StringBuilder("public Object getPropertyValue(Object o, String n){ ");
  
  // invokeMethod的覆写代码
  StringBuilder c3 = new StringBuilder("public Object invokeMethod(Object o, String n, Class[] p, Object[] v) throws " + InvocationTargetException.class.getName() + "{ ");

  
  // make class
  long id = WRAPPER_CLASS_COUNTER.getAndIncrement();
    ClassGenerator cc = ClassGenerator.newInstance(cl);
    cc.setClassName((Modifier.isPublic(c.getModifiers()) ? Wrapper.class.getName: c.getName() + "$sw") + id);
    
    // 设置父类为 Wrapper
    cc.setSuperClass(Wrapper.class);

    cc.addDefaultConstructor();
    cc.addField("public static String[] pns;"); // property name array.
    cc.addField("public static " + Map.class.getName() + " pts;"); // propertype map.
    cc.addField("public static String[] mns;"); // all method name array.
    cc.addField("public static String[] dmns;"); // declared method name array.
    for (int i = 0, len = ms.size(); i < len; i++) {
        cc.addField("public static Class[] mts" + i + ";");
    }

    cc.addMethod("public String[] getPropertyNames(){ return pns; }");
    cc.addMethod("public boolean hasProperty(String n){ retupts.containsKey($1); }");
    cc.addMethod("public Class getPropertyType(String n){ retu(Class)pts.get($1); }");
    cc.addMethod("public String[] getMethodNames(){ return mns; }");
    cc.addMethod("public String[] getDeclaredMethodNames(){ return dmns; }");
    
    // 动态生成覆写代码
    cc.addMethod(c1.toString());
    cc.addMethod(c2.toString());
    cc.addMethod(c3.toString());
    
    try {
      Class<?> wc = cc.toClass();
      // setup static field.
      wc.getField("pts").set(null, pts);
      wc.getField("pns").set(null, pts.keySet().toArray(new String[0]));
      wc.getField("mns").set(null, mns.toArray(new String[0]));
      wc.getField("dmns").set(null, dmns.toArray(new String[0]));
      int ix = 0;
      for (Method m : ms.values()) {
        wc.getField("mts" + ix++).set(null, m.getParameterTypes());
      }
      return (Wrapper) wc.newInstance();
    } catch (RuntimeException e) {
      throw e;
    } catch (Throwable e) {
      throw new RuntimeException(e.getMessage(), e);
    } finally {
      ...
      /* 省略 */
    }      
}
{% endhighlight %}

下面是通过`makeWrapper`生成的一个`Wrapper`子类的`invokeMethod`覆写方法，这些自动生成的代码都是从通过对目标对象进行反射得到的信息中生成的。

{% highlight java %}
// Foo
public static class Foo {
    public void bar(String value) {
      // some code        
    }
}

// 生成的Wrapper类的`invokeMethod()`覆写方法
public Object invokeMethod(Object o, String n, Class[] p, Object[] v) throws java.lang.reflect.InvocationTargetException {
    org.apache.dubbo.common.bytecode.WrapperTest$Foo w;
    try {
        w = ((org.apache.dubbo.common.bytecode.WrapperTest$Foo) $1);
    } catch (Throwable e) {
        throw new IllegalArgumentException(e);
    }
    try {
        if ("bar".equals($2) && $3.length == 1) {
            w.bar((java.lang.String) $4[0]);
            return null;
        }
    } catch (Throwable e) {
        throw new java.lang.reflect.InvocationTargetException(e);
    }
    throw new org.apache.dubbo.common.bytecode.NoSuchMethodException("Not found method \"" + $2 + "\" in class org.apache.dubbo.common.bytecode.WrapperTest$Foo.");
}
{% endhighlight %}

可以看到在动态生成的`invokeMethod()`中会调用目标对象对应的方法（生成代码中的`$1`和`$2`之类的变量表示的是`invokeMethod()`方法中的参数）

不同于JDK的反射实现方式，通过`Wrapper`的实现方式只有在第一次生成`Wrapper`的时候才会进行反射。当生成`Wrapper`以后，由于执行调用逻辑的代码是动态生成的，代码的执行过程并不需要进行反射来执行对应的方法，只需要执行动态生成的调用目标方法的逻辑就可以了，效率上会比反射方式更好，所以Dubbo的`ProxyFactory`默认实现用的是`JavassistProxyFactory`。

### 方法调用向Invoker转换

前面我们介绍了在服务提供方一侧如何将`Invoker`的`invoke()`调用转换成都执行某个对象的某个方法，下面我们来看下在服务消费方一侧是如何将方法调用转换成`Invoker`的`invoke()`调用的。

在服务消费者一侧，我们通过引用服务提供者提供的jar包来获得服务的接口定义，也就是说我们能获得的只有一个接口的定义，对于接口的实现则是放在服务提供者一侧，通过远程服务的方式提供调用。对于消费者一侧来说，如果需要调用实现在网络对端的服务，我们就需要将请求通过网络传输到服务端，服务端执行对应的方法以后再将请求结果通过网络传回发起请求的客户端。这个过程中涉及很多底层通信细节，RPC框架需要将这些细节对应用层屏蔽，比较好的方式是使用代理。

通过代理的方式，接口的调用方可以像调用本地接口一样调用方法，而具体的执行逻辑则由代理负责处理，应用层不用关系这些处理细节。我们只需要为服务提供方提供的jar包中的接口逐个实现代理类，那么我们就可以像调用本地实现一样调用远程的方法。

如果代理类需要应用开发人员自己手动创建，那么对于应用开发来说仍旧有认知负担，所以Dubbo将创建代理的事情也一并在框架层解决了。当应用引用服务的时候，Dubbo会在运行时为每个引用的服务创建代理类。在运行时创建代理类的技术就用到了Java的 **动态代理（Dynamic Proxy）** 。

Dubbo通过为接口创建动态代理类来实现方法调用到Invoker的转换，在代理类中调用`Invoker`执行`invoke`逻辑，而创建代理类的过程由于用到了Java的动态代理特性，所以不需要开发人员写任何代码。

Dubbo为接口创建动态代理类的实现也是在接口`ProxyFactory`中定义的：

{% highlight java %}
public interface ProxyFactory {
    @Adaptive({PROXY_KEY})
    <T> T getProxy(Invoker<T> invoker) throws RpcException;
    
    @Adaptive({PROXY_KEY})
    <T> T getProxy(Invoker<T> invoker, boolean generic) throws RpcException;
    
    /* 省略 */
}
{% endhighlight %}

`getProxy()`方法将`Invoker`对象转换成被代理的接口的代理类。同样Dubbo对动态代理也支持两种实现方式：

1. 基于JDK的`java.lang.reflect.Proxy`实现的动态代理
2. 基于javassist实现的动态代理

动态代理的主逻辑定义在抽象类`AbstractProxyFactory`中，而上述两种实现方式都基于模板方法模式[^2]实现`AbstractProxyFactory`中定义的`getProxy()`方法。

{% highlight java %}
public abstract class AbstractProxyFactory implements ProxyFactory {
    @Override
    public <T> T getProxy(Invoker<T> invoker) throws RpcException {
        return getProxy(invoker, false);
    }

    @Override
    public <T> T getProxy(Invoker<T> invoker, boolean generic) throws RpcException {
        Class<?>[] interfaces = null;
        String config = invoker.getUrl().getParameter(INTERFACES);
        if (config != null && config.length() > 0) {
            String[] types = COMMA_SPLIT_PATTERN.split(config);
            if (types != null && types.length > 0) {
                interfaces = new Class<?>[types.length + 2];
                interfaces[0] = invoker.getInterface();
                interfaces[1] = EchoService.class;
                for (int i = 0; i < types.length; i++) {
                    interfaces[i + 2] = ReflectUtils.forName(types[i]);
                }
            }
        }
        if (interfaces == null) {
            interfaces = new Class<?>[]{invoker.getInterface(), EchoService.class};
        }

        if (!GenericService.class.isAssignableFrom(invoker.getInterface()) && generic) {
            int len = interfaces.length;
            Class<?>[] temp = interfaces;
            interfaces = new Class<?>[len + 1];
            System.arraycopy(temp, 0, interfaces, 0, len);
            interfaces[len] = com.alibaba.dubbo.rpc.service.GenericService.class;
        }

        // 工厂方法模式的应用，将Proxy的创建委托给子类实现
        return getProxy(invoker, interfaces);
    }

    // 被特定实现继承的动态代理实现
    public abstract <T> T getProxy(Invoker<T> invoker, Class<?>[] types);
}
{% endhighlight %}

`getProxy()`的实现中，从`Invoker`中获取到`interface`列表，然后调用`AbstractProxyFactory`中定义的`getProxy()`模板方法创建动态代理，而具体创建动态代理的逻辑则交给了`AbstractProxyFactory`的子类来实现，这里被子类继承的`getProxy()`其实是一个 **工厂方法模式（Factory method pattern）**[^4] 的实现。

下面是基于JDK的动态代理实现，实现源码在`JdkProxyFactory`中：

{% highlight java %}
public class JdkProxyFactory extends AbstractProxyFactory {
    @Override
    @SuppressWarnings("unchecked")
    public <T> T getProxy(Invoker<T> invoker, Class<?>[] interfaces) {
        return (T) Proxy.newProxyInstance(Thread.currentThread().getContextClassLoader(), interfaces, new InvokerInvocationHandler(invoker));
    }
    
    /* 省略 */
}


{% endhighlight %}

基于JDK的动态代理实现，动态代理代码是由JDK自动生成的，对于动态代理方法的拦截则通过`InvocationHandler`来实现。我们可以从`InvokerInvocationHandler`这个`InvocationHandler`实现类中看到Dubbo是如何将方法调用转换成`Invoker`调用的：

{% highlight java %}
public class InvokerInvocationHandler implements InvocationHandler {
    /* 省略 */
    
    public InvokerInvocationHandler(Invoker<?> handler) {
        this.invoker = handler;
    }

    @Override
    public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
        String methodName = method.getName();
        Class<?>[] parameterTypes = method.getParameterTypes();
        if (method.getDeclaringClass() == Object.class) {
            return method.invoke(invoker, args);
        }
        if ("toString".equals(methodName) && parameterTypes.length == 0) {
            return invoker.toString();
        }
        if ("hashCode".equals(methodName) && parameterTypes.length == 0) {
            return invoker.hashCode();
        }
        if ("equals".equals(methodName) && parameterTypes.length == 1) {
            return invoker.equals(args[0]);
        }
        return invoker.invoke(new RpcInvocation(method, args)).recreate();
    }
}
{% endhighlight %}

可以看到，在`InvokerInvocationHandler`的`invoke()`实现中，调用了`Invoker`的`invoke()`方法来实现从方法调用向`Invoker`的转换。

`JavassistProxyFactory`对`getProxy()`的实现原理和`JdkProxyFactory`对`getProxy()`的实现基本一样，唯一的区别是：`JavassistProxyFactory`是通过 **javassist** 框架的字节码生成功能来生成动态代理类的，创建过程由Dubbo框架自己实现，而`JdkProxyFactory`中对动态代理类的创建则是随着JDK包由官方提供。

**javassist** 实现的`Proxy`类在`org.apache.dubbo.common.bytecode.Proxy`中，感兴趣的同学可以自行分析，这里不再展开。

到这里，我们已经清楚了Dubbo在屏蔽底层细节的时候是怎么做的了。知道了如何和`Invoker`进行转换，那么关于RPC中底层通信的部分，我们就可以将关注点放到`Invoker`上了，只要把`Invoker`的`invoke`逻辑实现正确，那么转换到应用层的时候就可以利用上面我们提到的技术完成转换。所以你将会发现：Dubbo的实现和复杂性都是围绕着`Invoker`展开的。不管是我们上文提到的方法调用还是以后我们将会讲到的负载均衡和集群容错相关的主题，都和`Invoker`密不可分。

接下来我们来看本文的最后一部分内容，从RPC层面看下服务是如何引用和暴露的（*注意：Dubbo完整的服务引用和暴露流程贯穿了整个Dubbo框架，涉及到我们未来会介绍的关于服务发现的主题，所以这里我们只关注单纯RPC层面非透明的服务引用和服务暴露过程*）。

## 服务引用和暴露

由于远程过程调用需要跨进程（跨网络）进行通信，所以RPC框架一般都是CS架构。在服务消费者一侧，需要创建一个客户端和服务提供方进行数据通信，这个过程在Dubbo是通过引用服务来完成的；而在服务提供方一侧，则需要创建一个服务端以供客户端访问，这个过程通过暴露服务来完成。

Dubbo在通信层之上抽象了一个协议层用于定义由不同协议实现的RPC扩展。在协议层中的核心类是`Protocol`。Dubbo通过`Protocol`的`refer()`和`export()`来进行服务引用和暴露过程。各个协议扩展可以通过实现自己的`refer()`和`export()`来完成自定义的服务引用和暴露过程。

{% highlight java %}
@SPI("dubbo")
public interface Protocol {
    int getDefaultPort();

    @Adaptive
    <T> Exporter<T> export(Invoker<T> invoker) throws RpcException;

    @Adaptive
    <T> Invoker<T> refer(Class<T> type, URL url) throws RpcException;

    void destroy();
}
{% endhighlight %}

接下来，我们通过 **dubbo协议** 的协议层实现`DubboProtocol`来看下服务的引用和暴露过程。

### 引用

Dubbo服务的引用过程通过`Protocol`的`refer()`方法实现。在`DubboProtocol`的`refer()`实现中，继承了抽象父类`AbstractProtocol`中实现的`refer()`方法：

{% highlight java %}
public abstract class AbstractProtocol implements Protocol {
  /* 省略 */
  @Override
  public <T> Invoker<T> refer(Class<T> type, URL url) throws RpcException {
    return new AsyncToSyncInvoker<>(protocolBindingRefer(type, url));
  }
  
  protected abstract <T> Invoker<T> protocolBindingRefer(Class<T> type, URL url) throws RpcException;
}
{% endhighlight %}

`AbstractProtocol`中定义了`protocolBindingRefer()`抽象方法，由具体的子类实现引用的逻辑。其中在`refer()`中，将`protocolBindingRefer()`返回的`Invoker`对象包装到`AsyncToSyncInvoker`类中，目的是为了当Dubbo的调用是同步模式的情况下需要将异步模式转换成同步模式（Dubbo默认是同步模式，除非`async`参数被配置为`true`）。下面是`DubboProtocol`实现的`protocolBindingRefer()`方法：

{% highlight java %}
public class DubboProtocol extends AbstractProtocol {
  /* 省略 */
  
  @Override
  public <T> Invoker<T> protocolBindingRefer(Class<T> serviceType, URL url) throws RpcException {
    // 优化序列化
    optimizeSerialization(url);

    // 创建Invoker
    DubboInvoker<T> invoker = new DubboInvoker<T>(serviceType, url, getClients(url), invokers);
    
    // invokers的目的是记录创建的Invoker，用于invoker退出的时候执行回收逻辑
    // Dubbo的实现者在实现这块的时候设计不是很优雅，对于Invoker回收的模块应该独立设计
    invokers.add(invoker);

    return invoker;
  }
  
  /* 省略 */
}
{% endhighlight %}

`protocolBindingRefer()`创建了一个`DubboInvoker`对象，在创建`DubboInvoker`的时候调用了`getClients()`创建客户端列表。在`getClients()`中将创建用于连接服务端（服务提供方）的`Client`对象。

#### 连接控制

**Dubbo协议在客户端和服务端之间是通过TCP长连接通信的，默认情况下只会维护一个长连接，但是如果在引用服务的时候在消费方（或服务提供方）配置了连接数（`connections`配置），那么Dubbo会为配置的那个service单独维护一个连接集合。而没有配置连接的则统一共享一个TCP连接。**

{% highlight xml %}
<dubbo:reference interface="com.foo.BarService" connections="10" />
<dubbo:service interface="com.foo.BarService" connections="10" />
{% endhighlight %}

注意：上面的两个配置，如果在服务提供方和服务消费方都配置，则按照配置的覆盖规则，`<dubbo:reference/>`的配置优先[^5]。

下面是创建客户端的逻辑：

{% highlight java %}
public class DubboProtocol extends AbstractProtocol {
  /* 省略 */
  
  private ExchangeClient[] getClients(URL url) {
      // whether to share connection

      boolean useShareConnect = false;

      int connections = url.getParameter(CONNECTIONS_KEY, 0);
      List<ReferenceCountExchangeClient> shareClients = null;
      // if not configured, connection is shared, otherwise, one connection for one service
      if (connections == 0) {
          useShareConnect = true;

          /**
           * The xml configuration should have a higher priority than properties.
           */
          String shareConnectionsStr = url.getParameter(SHARE_CONNECTIONS_KEY, (String) null);
          connections = Integer.parseInt(StringUtils.isBlank(shareConnectionsStr) ? ConfigUtils.getProperty(SHARE_CONNECTIONS_KEY,
                  DEFAULT_SHARE_CONNECTIONS) : shareConnectionsStr);
                  
          // 创建共享连接
          shareClients = getSharedClient(url, connections);
      }

      ExchangeClient[] clients = new ExchangeClient[connections];
      for (int i = 0; i < clients.length; i++) {
          if (useShareConnect) {
              clients[i] = shareClients.get(i);

          } else {
              // 不使用共享连接，单独创建连接
              clients[i] = initClient(url);
          }
      }

      return clients;
  }  
  
  /* 省略 */
}
{% endhighlight %}

从这段逻辑中可以看到，Dubbo首先判断引用配置是否有`connections`，如果没有则表示使用共享连接，通过调用`getSharedClient()`获取共享连接，如果配置了`connections`则表示不使用共享连接，通过`initClient()`创建连接。下面是获取共享连接的逻辑：

{% highlight java %}
private List<ReferenceCountExchangeClient> getSharedClient(URL url, int connectNum) {
    // 使用服务端的ip + 端口作为缓存的key缓存共享连接
    String key = url.getAddress();
    List<ReferenceCountExchangeClient> clients = referenceClientMap.get(key);

    if (checkClientCanUse(clients)) {
        batchClientRefIncr(clients);
        return clients;
    }

    // 按照服务器地址来处理锁的粒度，减少不必要的并发冲突
    locks.putIfAbsent(key, new Object());
    synchronized (locks.get(key)) {
        clients = referenceClientMap.get(key);
        // dubbo check
        if (checkClientCanUse(clients)) {
            batchClientRefIncr(clients);
            return clients;
        }

        // connectNum must be greater than or equal to 1
        connectNum = Math.max(connectNum, 1);

        // If the clients is empty, then the first initialization is
        if (CollectionUtils.isEmpty(clients)) {
            clients = buildReferenceCountExchangeClientList(url, connectNum);
            referenceClientMap.put(key, clients);

        } else {
            for (int i = 0; i < clients.size(); i++) {
                ReferenceCountExchangeClient referenceCountExchangeClient = clients.get(i);
                // If there is a client in the list that is no longer available, create a new one to replace him.
                if (referenceCountExchangeClient == null || referenceCountExchangeClient.isClosed()) {
                    clients.set(i, buildReferenceCountExchangeClient(url));
                    continue;
                }

                referenceCountExchangeClient.incrementAndGetCount();
            }
        }

        /**
         * I understand that the purpose of the remove operation here is to avoid the expired url key
         * always occupying this memory space.
         */
        locks.remove(key);

        return clients;
    }
}
{% endhighlight %}

在获取共享连接的时候会检查连接是否可用，如果不可用需要创建新的连接并将旧的连接销毁。这里用远程服务的地址作为key来缓存共享的连接集合。同时在加锁的时候，为每个服务端都分配独立的锁来处理并发问题（利用服务端的网络地址作为key），减少并发冲突。

分析到这里，我们可以看到：在服务引用一侧，当执行`Protocol`的`refer()`以后Dubbo会创建一个`DubboInvoker`，在`DubboInvoker`中会保存一份用于连接服务提供方的客户端列表。客户端列表中的客户端通过创建一个连接到服务提供方所在服务器的TCP长连接来和服务端进行通信。默认情况下客户端会为服务提供方的每个服务器维护一个共享的TCP长连接。

### 暴露

Dubbo服务的暴露通过`Protocol`的`export()`来完成。下面是`DubboProtocol`中服务暴露的实现：

{% highlight java %}
public class DubboProtocol extends AbstractProtocol {
  /* 省略 */
  
  @Override
  public <T> Exporter<T> export(Invoker<T> invoker) throws RpcException {
      URL url = invoker.getUrl();

      // export service.
      String key = serviceKey(url);
      
      // 创建Exporter
      DubboExporter<T> exporter = new DubboExporter<T>(invoker, key, exporterMap);
      exporterMap.put(key, exporter);

      //export an stub service for dispatching event
      Boolean isStubSupportEvent = url.getParameter(STUB_EVENT_KEY, DEFAULT_STUB_EVENT);
      Boolean isCallbackservice = url.getParameter(IS_CALLBACK_SERVICE, false);
      if (isStubSupportEvent && !isCallbackservice) {
          String stubServiceMethods = url.getParameter(STUB_EVENT_METHODS_KEY);
          if (stubServiceMethods == null || stubServiceMethods.length() == 0) {
              if (logger.isWarnEnabled()) {
                  logger.warn(new IllegalStateException("consumer [" + url.getParameter(INTERFACE_KEY) +
                          "], has set stubproxy support event ,but no stub methods founded."));
              }

          } else {
              stubServiceMethodsMap.put(url.getServiceKey(), stubServiceMethods);
          }
      }

      // 启动服务
      openServer(url);
      
      // 优化序列化
      optimizeSerialization(url);

      return exporter;
  }
  
  /* 省略 */
}
{% endhighlight %}

`DubboProtocol`在`export()`中创建了一个`Exporter`，然后调用`openServer()`启动服务端用于监听来自客户端的请求。

{% highlight java %}
public class DubboProtocol extends AbstractProtocol {
  private void openServer(URL url) {
      // find server.
      String key = url.getAddress();
      //client can export a service which's only for server to invoke
      boolean isServer = url.getParameter(IS_SERVER_KEY, true);
      if (isServer) {
          // 检查服务是否已经启动
          ExchangeServer server = serverMap.get(key);
          if (server == null) {
              synchronized (this) {
                  server = serverMap.get(key);
                  if (server == null) {
                      // 服务不存在，新建并启动服务
                      serverMap.put(key, createServer(url));
                  }
              }
          } else {
              // server supports reset, use together with override
              server.reset(url);
          }
      }
  }
  
  private ExchangeServer createServer(URL url) {
      url = URLBuilder.from(url)
              // send readonly event when server closes, it's enabled by default
              .addParameterIfAbsent(CHANNEL_READONLYEVENT_SENT_KEY, Boolean.TRUE.toString())
              // enable heartbeat by default
              .addParameterIfAbsent(HEARTBEAT_KEY, String.valueOf(DEFAULT_HEARTBEAT))
              .addParameter(CODEC_KEY, DubboCodec.NAME)
              .build();
      String str = url.getParameter(SERVER_KEY, DEFAULT_REMOTING_SERVER);

      if (str != null && str.length() > 0 && !ExtensionLoader.getExtensionLoader(Transporter.class).hasExtension(str)) {
          throw new RpcException("Unsupported server type: " + str + ", url: " + url);
      }

      ExchangeServer server;
      try {
          server = Exchangers.bind(url, requestHandler);
      } catch (RemotingException e) {
          throw new RpcException("Fail to start server(url: " + url + ") " + e.getMessage(), e);
      }

      str = url.getParameter(CLIENT_KEY);
      if (str != null && str.length() > 0) {
          Set<String> supportedTypes = ExtensionLoader.getExtensionLoader(Transporter.class).getSupportedExtensions();
          if (!supportedTypes.contains(str)) {
              throw new RpcException("Unsupported client type: " + str);
          }
      }

      return server;
  }
}
{% endhighlight %}

在`openServer()`中，先通过服务地址检查服务是否已经启动，如果没有则通过`createServer()`创建一个服务并启动。在`createServer()`中通过`Exchangers.bind(url, requestHandler)`启动一个服务，并且通过`requestHandler`处理所有请求。在`requestHandler`中会通过请求的信息路由到对应的`Invoker`，执行`Invoker`的`invoke`逻辑并将结果通过网络返回给客户端。

分析到这里我们可以知道，在`export()`中Dubbo会启动一个服务并监听外部请求，并处理所有访问进来的请求，在`requestHandler`中将请求向上路由到对应的`Invoker`并得到执行，而这个`Invoker`对应的就是服务提供方提供的方法实现，这个我们在上面关于 **实现远程方法调用的原理** 一节中已经介绍过关于`Invoker`的转换了。

#### Exporter
`Protocol`的`export()`方法会返回一个`Exporter`对象。`Exporter`是Dubbo中对应暴露的服务的包装，通过`Exporter`的`getInvoker()`可以获取到已经被暴露的`Invoker`对象，以及提供`unexport()`方法注销已经暴露的Invoker：

{% highlight java %}
public interface Exporter<T> {
    Invoker<T> getInvoker();

    void unexport();
}
{% endhighlight %}

## 总结
本文简要介绍了Dubbo作为一个RPC框架的整体架构，阐述了RPC的基本原理。从Dubbo框架关于RPC部分作为切入点，分析了Dubbo是如何抽象服务调用以及如何跟Java语言结合实现一个点对点的RPC框架。从RPC的角度分析了服务暴露和服务引用的过程。只要了解Dubbo关于RPC部分的实现，基本就掌握了一个RPC的主流程。关于RPC如何处理通信细节，将是我们下一篇的主题。

[^1]:[https://en.wikipedia.org/wiki/Remote_procedure_call](https://en.wikipedia.org/wiki/Remote_procedure_call)
[^2]:[https://en.wikipedia.org/wiki/Template_method_pattern](https://en.wikipedia.org/wiki/Template_method_pattern)
[^3]:[http://www.javassist.org/tutorial/tutorial.html](http://www.javassist.org/tutorial/tutorial.html)
[^4]:[https://en.wikipedia.org/wiki/Factory_method_pattern](https://en.wikipedia.org/wiki/Factory_method_pattern)
[^5]:[http://dubbo.apache.org/zh-cn/docs/user/demos/config-connections.html](http://dubbo.apache.org/zh-cn/docs/user/demos/config-connections.html)
