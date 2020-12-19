---
layout: post
title: Dubbo源码解析——线程模型
date: "2020-02-10 18:00:00 +0800"
categories: Dubbo
tags: java Dubbo rpc
published: true
---

## 前言

在[《Dubbo源码解析——远程通信》](/2020/02/06/Dubbo源码解析-远程通信)一文中我们分析了Dubbo的远程通信设计和实现。Dubbo的通信层接收到来自网络上的请求（响应）以后，会解析请求（响应）报文并执行应用的逻辑。负责执行应用逻辑的线程就是接收到网络请求（响应）的那个IO线程。如果应用代码执行很慢，或者执行过程中出现阻塞（比如：调用了网络请求），那么执行应用代码的这个IO线程就一直得不到释放，也就没法继续被调度处理新的网络请求，进而导致系统吞吐量下降。

为了避免这种情况的发生，Dubbo实现了自己的线程模型，将执行应用层代码的线程和处理IO的线程区分开。

## Dubbo的线程模型
Dubbo在接收到网络请求以后，会基于应用的配置选择是将请求分派到独立的线程池执行，还是继续由IO线程执行。在XML配置方式中可以用如下方式配置：

{% highlight xml %}
<dubbo:protocol name="dubbo" dispatcher="all" threadpool="fixed" threads="100" />
{% endhighlight %}

`dispatcher`参数设置请求的分派逻辑方式，`threadpool`参数表示请求被分派到哪种线程池实现中执行，`threads`设置线程池的大小。

当Dubbo配置了`dispatcher`以后，通信层接收到来自网络的请求以后会基于配置的分派方式对消息进行处理。Dubbo提供的分派方式有5中：

* `all`所有请求都分派到线程池，包括调用请求、响应、打开连接、断开连接、心跳等。
* `direct`所有请求都不派发线程池，全部在IO线程上处理。
* `message`只把请求和响应消息分派到线程池，其他消息都在IO线程上处理，比如连接断开，心跳等。
* `execution`只把请求消息派发到线程池，其他消息，包括响应消息都在IO线程上执行。
* `connection`对连接断开事件放入队列，由IO线程逐个执行，其他消息统一派发到线程池。

框架的使用者可以基于业务和应用的现状选择需要的分派方式。

除了分派方式，Dubbo还提供了配置处理任务的线程池的参数`threadpool`，Dubbo提供了4种线程池方案：

* `fixed` 固定大小的线程池，用的是JUC并发包中的`FixedThreadPoolExecutor`实现。
* `cached` 缓存线程池，如果线程池中线程有空闲则会在一定超时时间后回收。
* `limited` 可伸缩的线程池，但是不同于`CachedThreadPoolExecutor`，改线程池只会增长不会收缩，目的是防止在收缩的时候突然有大流量进来引起性能问题。
* `eager` 一个`ThreadPoolExecutor`实现。`eager`线程池实现和`ThreadPoolExecutor`的区别是：当线程池中工作线程数达到或超过核心线程数以后，前者会优先创建工作线程，当工作线程池达到上限以后才会将任务入队；而后者会优先将任务入队，当队列满了以后才会创建工作线程。

下面，我们来看下Dubbo是如何实现请求消息的分派的。

## 消息分派

我们在《Dubbo源码解析——远程通信》中已经介绍过，Dubbo在通信层用到了异步IO框架，比如Netty，Mina等。在异步IO框架中，来自网络的外部请求都会被处理成一个读事件并被这些IO框架的事件处理器处理。这些事件处理器都有一个IO线程绑定并由这些IO线程处理，比如Netty中的`EventGroup`。所以如果我们不将受到的请求分派到线程池中，那么这些请求就会被处理这些事件的IO线程处理。这么做的弊端前面我们也提到了，如果处理的请求很慢，会导致IO线程被占用，没有更多的IO线程去处理外部请求导致服务的吞吐量下降。

Dubbo在实现消息分派的时候，考虑到消息都是由事件处理器执行的，比如Dubbo的`ChannelHandler`就是用来处理网络事件的，所以在实现上采用 **装饰器模式（Decorator pattern）**[^1] 来给`ChannelHandler`增加分派消息的能力。

Dubbo使用装饰器模式对`ChannelHandler`进行增强的逻辑在各个`Client`和`Server`的实现类中，这里我们以`NettyClient`为例来介绍：

{% highlight java %}
public class NettyClient extends AbstractClient {
  public NettyClient(final URL url, final ChannelHandler handler) throws RemotingException {
      super(url, wrapChannelHandler(url, handler)); // 1
  }
}

public abstract class AbstractClient extends AbstractEndpoint implements Client {
  protected static ChannelHandler wrapChannelHandler(URL url, ChannelHandler handler) {
      url = ExecutorUtil.setThreadName(url, CLIENT_THREAD_POOL_NAME);
      url = url.addParameterIfAbsent(THREADPOOL_KEY, DEFAULT_CLIENT_THREADPOOL);
      return ChannelHandlers.wrap(handler, url); // 2
  }
}
{% endhighlight %}

1. 通过`wrapChannelHandler()`方法对`handler`进行增强。
2. `wrapChannelHandler()`方法是父类`AbstractClient`实现的一个方法，它将装饰逻辑委托给了`ChannelHandlers`的`wrap()`方法。

{% highlight java %}
public class ChannelHandlers {
    /* 省略 */
    
    public static ChannelHandler wrap(ChannelHandler handler, URL url) {
        return ChannelHandlers.getInstance().wrapInternal(handler, url); // 1
    }
    
    /* 省略 */

    protected ChannelHandler wrapInternal(ChannelHandler handler, URL url) {
        return new MultiMessageHandler(new HeartbeatHandler(ExtensionLoader.getExtensionLoader(Dispatcher.class)
                .getAdaptiveExtension().dispatch(handler, url))); // 2
    }
}

@SPI(AllDispatcher.NAME) // 4
public interface Dispatcher {
    @Adaptive({Constants.DISPATCHER_KEY, "dispather", "channel.handler"})
    ChannelHandler dispatch(ChannelHandler handler, URL url); // 3
}
{% endhighlight %}

1. `wrap()`静态方法又调用了实例方法`wrapInternal()`实现真正的包装。
2. 这里用到了Dubbo的扩展加载机制，通过`ExtensionLoader`加载Dispatcher扩展。上面我们提到的5种分派方式，在Dubbo中都是通过扩展实现的。关于扩展的内容我们暂且按下不表，后面我们会单独拎出来分析。我们先看分派的实现，这里`getAdaptiveExtension()`会返回具体的`Dispatcher`实现。
3. `Dispatcher`接口包含了一个`dispatch()`方法，该方法将传入的`ChannelHandler`对象进行装饰，装饰后的`ChannelHandler`在处理逻辑的时候会基于不同的`Dispatcher`实现使用不同的分派策略。
4. Dubbo默认使用的分派策略是`all`，对应到的`Dispatcher`实现就是`AllDispatcher`。

Dubbo关于`Dispatcher`的实现都在`org.apache.dubbo.remoting.transport.dispatcher`包中，下面我们来逐个分析`Dispatcher`的实现。

### AllDispatcher
首先，我们先来看下Dubbo默认使用的分派策略`all`。我们面介绍过，`all`的分配策略下会将所有消息都分派到线程池中执行。对应到Dubbo的`Dispatcher`实现，就是`AllDispatcher`：

{% highlight java %}
public class AllDispatcher implements Dispatcher {
    public static final String NAME = "all";

    @Override
    public ChannelHandler dispatch(ChannelHandler handler, URL url) {
        return new AllChannelHandler(handler, url);
    }
}
{% endhighlight %}

在`AllDispatcher`的`dispatch()`方法中创建了一个`AllChannelHandler`对象，`AllChannelHandler`对传入的`handler`进行了封装。在`AllChannelHandler`中实现了`all`分派策略的逻辑，我们一起来看下：

{% highlight java %}
public class AllChannelHandler extends WrappedChannelHandler { // 1
    public AllChannelHandler(ChannelHandler handler, URL url) {
        super(handler, url);
    }

    @Override
    public void connected(Channel channel) throws RemotingException { // 2
        ExecutorService executor = getExecutorService();
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.CONNECTED));
        } catch (Throwable t) {
            throw new ExecutionException("connect event", channel, getClass() + " error when process connected event .", t);
        }
    }

    @Override
    public void disconnected(Channel channel) throws RemotingException { // 3
        ExecutorService executor = getExecutorService();
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.DISCONNECTED));
        } catch (Throwable t) {
            throw new ExecutionException("disconnect event", channel, getClass() + " error when process disconnected event .", t);
        }
    }

    @Override
    public void received(Channel channel, Object message) throws RemotingException { // 4
        ExecutorService executor = getExecutorService();
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.RECEIVED, message));
        } catch (Throwable t) {
        	if(message instanceof Request && t instanceof RejectedExecutionException){
        		Request request = (Request)message;
        		if(request.isTwoWay()){
        			String msg = "Server side(" + url.getIp() + "," + url.getPort() + ") threadpool is exhausted ,detail msg:" + t.getMessage();
        			Response response = new Response(request.getId(), request.getVersion());
        			response.setStatus(Response.SERVER_THREADPOOL_EXHAUSTED_ERROR);
        			response.setErrorMessage(msg);
        			channel.send(response);
        			return;
        		}
        	}
            throw new ExecutionException(message, channel, getClass() + " error when process received event .", t);
        }
    }

    @Override
    public void caught(Channel channel, Throwable exception) throws RemotingException {
        ExecutorService executor = getExecutorService();
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.CAUGHT, exception));
        } catch (Throwable t) {
            throw new ExecutionException("caught event", channel, getClass() + " error when process caught event .", t);
        }
    }
}
{% endhighlight %}

1. `AllChannelHandler`继承`WrappedChannelHandler`。
2. `connected()`方法处理连接创建消息，当调用`connected()`被调用以后，被装饰的`handler`的逻辑会被封装到`ChannelEventRunnable`的`run()`方法中，提交给线程池执行。在`run()`方法中会基于传入的`ChannelState`的值判断执行`ChannelHandler`的哪一个方法。
3. `disconnected()`连接断开消息，和`connected()`一样的方式被封装，我们不再赘述。
4. `received()`方法处理请求和响应消息。当处理请求和响应的时候如果线程池满了，则会向对端发送超过线程池容量的消息：`Server side(ip:port) threadpool is exhausted ,detail msg: ...`。

#### WrappedChannelHandler

所有分派器实现的`handler`的包装类都继承自`WrappedChannelHandler`类（`direct`分派器除外，下面我们会讲到）。在`WrappedChannelHandler`中完成了线程池扩展的加载。

{% highlight java %}
public class WrappedChannelHandler implements ChannelHandlerDelegate {
    protected static final ExecutorService SHARED_EXECUTOR = Executors.newCachedThreadPool(new NamedThreadFactory("DubboSharedHandler", true)); // 1

    protected final ExecutorService executor;

    protected final ChannelHandler handler;

    protected final URL url;

    public WrappedChannelHandler(ChannelHandler handler, URL url) {
        this.handler = handler;
        this.url = url;
        executor = (ExecutorService) ExtensionLoader.getExtensionLoader(ThreadPool.class).getAdaptiveExtension().getExecutor(url); // 2
        /* 省略 */
    }

    /* 省略 */

    public ExecutorService getExecutorService() {
        ExecutorService cexecutor = executor;
        if (cexecutor == null || cexecutor.isShutdown()) {
            cexecutor = SHARED_EXECUTOR; // 3
        }
        return cexecutor;
    }
}
{% endhighlight %}

1. 创建默认的共享线程池，当扩展线程池没有提供或者被关闭以后，使用共享线程池代替。共享线程池的实现用的是JUC中的是无容量限制的`ThreadPoolExecutor`实现。
2. `WrappedChannelHandler`在构造方法中通过Dubbo的扩展加载机制加载了具体的线程池实现`ThreadPool`。
3. `WrappedChannelHandler`中定义了`getExecutorService()`方法用于获取执行消息的线程池，如果没有指定线程池，则默认使用在`WrappedChannelHandler`中定义的共享线程池`SHARED_EXECUTOR`。

#### ChannelEventRunnable

`ChannelEventRunnable`是对派发给线程池执行的消息的封装，在`run()`方法中按照`ChannelState`的类型执行对应的`handler`的方法。

{% highlight java %}
public class ChannelEventRunnable implements Runnable {
  public void run() {
      if (state == ChannelState.RECEIVED) { // 1
          try {
              handler.received(channel, message);
          } catch (Exception e) {
              logger.warn("ChannelEventRunnable handle " + state + " operation error, channel is " + channel
                      + ", message is " + message, e);
          }
      } else {
          switch (state) { // 2
          case CONNECTED:
              try {
                  handler.connected(channel);
              } catch (Exception e) {
                  logger.warn("ChannelEventRunnable handle " + state + " operation error, channel is " + channel, e);
              }
              break;
          case DISCONNECTED:
              try {
                  handler.disconnected(channel);
              } catch (Exception e) {
                  logger.warn("ChannelEventRunnable handle " + state + " operation error, channel is " + channel, e);
              }
              break;
          case SENT:
              try {
                  handler.sent(channel, message);
              } catch (Exception e) {
                  logger.warn("ChannelEventRunnable handle " + state + " operation error, channel is " + channel
                          + ", message is " + message, e);
              }
              break;
          case CAUGHT:
              try {
                  handler.caught(channel, exception);
              } catch (Exception e) {
                  logger.warn("ChannelEventRunnable handle " + state + " operation error, channel is " + channel
                          + ", message is: " + message + ", exception is " + exception, e);
              }
              break;
          default:
              logger.warn("unknown state: " + state + ", message is " + message);
          }
      }
  }
}
{% endhighlight %}

1. 如果`ChannelState`为`RECEIVED`则执行请求和响应消息。
2. 按照不同的`ChannelState`的值处理不同的消息，比如连接创建和关闭的消息。

### DirectDispatcher

`direct`分配策略的实现在`DirectDispatcher`中。由于`direct`的分派逻辑是所有消息都在IO线程上执行，所以`DirectDispatcher`的`dispatch()`实现很简单，直接返回了没有被装饰的`handler`对象。

{% highlight java %}
public class DirectDispatcher implements Dispatcher {

    public static final String NAME = "direct";

    @Override
    public ChannelHandler dispatch(ChannelHandler handler, URL url) {
        return handler;
    }
}
{% endhighlight %}

### ConnectionOrderedDispatcher
`ConnectionOrderedDispatcher`实现了`connection`分派策略。`dispatch()`方法返回了`handler`的装饰器`ConnectionOrderedChannelHandler`。

{% highlight java %}
public class ConnectionOrderedDispatcher implements Dispatcher {

    public static final String NAME = "connection";

    @Override
    public ChannelHandler dispatch(ChannelHandler handler, URL url) {
        return new ConnectionOrderedChannelHandler(handler, url);
    }
}
{% endhighlight %}

`connection`的分派策略会将所有连接相关的消息按顺序执行，其他消息分派到线程池执行。实现逻辑被包装在`ConnectionOrderedChannelHandler`中。

{% highlight java %}
public class ConnectionOrderedChannelHandler extends WrappedChannelHandler {
    protected final ThreadPoolExecutor connectionExecutor; // 1
    private final int queuewarninglimit; // 3

    public ConnectionOrderedChannelHandler(ChannelHandler handler, URL url) {
        super(handler, url);
        String threadName = url.getParameter(THREAD_NAME_KEY, DEFAULT_THREAD_NAME);
        connectionExecutor = new ThreadPoolExecutor(1, 1,
                0L, TimeUnit.MILLISECONDS,
                new LinkedBlockingQueue<Runnable>(url.getPositiveParameter(CONNECT_QUEUE_CAPACITY, Integer.MAX_VALUE)), // 2
                new NamedThreadFactory(threadName, true),
                new AbortPolicyWithReport(threadName, url)
        ); // 1
        queuewarninglimit = url.getParameter(CONNECT_QUEUE_WARNING_SIZE, DEFAULT_CONNECT_QUEUE_WARNING_SIZE); // 3
    }

    @Override
    public void connected(Channel channel) throws RemotingException { // 4
        try {
            checkQueueLength(); // 3
            connectionExecutor.execute(new ChannelEventRunnable(channel, handler, ChannelState.CONNECTED));
        } catch (Throwable t) {
            throw new ExecutionException("connect event", channel, getClass() + " error when process connected event .", t);
        }
    }

    @Override
    public void disconnected(Channel channel) throws RemotingException { // 4
        try {
            checkQueueLength();
            connectionExecutor.execute(new ChannelEventRunnable(channel, handler, ChannelState.DISCONNECTED));
        } catch (Throwable t) {
            throw new ExecutionException("disconnected event", channel, getClass() + " error when process disconnected event .", t);
        }
    }

    @Override
    public void received(Channel channel, Object message) throws RemotingException {
        ExecutorService executor = getExecutorService(); // 5
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.RECEIVED, message));
        } catch (Throwable t) {
            //fix, reject exception can not be sent to consumer because thread pool is full, resulting in consumers waiting till timeout.
            if (message instanceof Request && t instanceof RejectedExecutionException) {
                Request request = (Request) message;
                if (request.isTwoWay()) {
                    String msg = "Server side(" + url.getIp() + "," + url.getPort() + ") threadpool is exhausted ,detail msg:" + t.getMessage();
                    Response response = new Response(request.getId(), request.getVersion());
                    response.setStatus(Response.SERVER_THREADPOOL_EXHAUSTED_ERROR);
                    response.setErrorMessage(msg);
                    channel.send(response);
                    return;
                }
            }
            throw new ExecutionException(message, channel, getClass() + " error when process received event .", t);
        }
    }

    @Override
    public void caught(Channel channel, Throwable exception) throws RemotingException {
        ExecutorService executor = getExecutorService();
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.CAUGHT, exception));
        } catch (Throwable t) {
            throw new ExecutionException("caught event", channel, getClass() + " error when process caught event .", t);
        }
    }

    private void checkQueueLength() { // 3
        if (connectionExecutor.getQueue().size() > queuewarninglimit) {
            logger.warn(new IllegalThreadStateException("connectionordered channel handler `queue size: " + connectionExecutor.getQueue().size() + " exceed the warning limit number :" + queuewarninglimit));
        }
    }
}
{% endhighlight %}

1. 为连接消息创建独立的线程池。由于需要满足顺序执行连接消息的目的，处理连接消息的线程池是一个只有一个工作线程的固定线程池`FixedThreadPoolExecutor`实现。
2. 消息处理队列的实现用的是`LinkedBlockingQueue`。如果队列长度限制`connect.queue.capacity`值没有配置则不限队列容量。
3. 获取队列长度预警阈值`connect.queue.warning.size`。默认长度为`DEFAULT_CONNECT_QUEUE_WARNING_SIZE = 1000`。在处理连接消息前会通过`checkQueueLength()`检查当前队列中的任务数量是否超过了设置的预警阈值，如果超过则在日志中记录warn日志。
4. 使用单线程池线程池顺序处理连接创建和关闭消息。
5. 和`AllDispatcher`逻辑一样，请求和响应消息在预设的线程池中执行。

### ExecutionDispatcher

`execution`分派策略只会将请求的消息分派到线程池执行，其他的消息一概在IO线程上执行。`ExecutionDispatcher`实现了`execution`分派器。

{% highlight java %}
public class ExecutionDispatcher implements Dispatcher {

    public static final String NAME = "execution";

    @Override
    public ChannelHandler dispatch(ChannelHandler handler, URL url) {
        return new ExecutionChannelHandler(handler, url);
    }
}
{% endhighlight %}

`ExecutionChannelHandler`包装了`execution`分派的策略：

{% highlight java %}
public class ExecutionChannelHandler extends WrappedChannelHandler {
    public ExecutionChannelHandler(ChannelHandler handler, URL url) {
        super(handler, url);
    }

    @Override
    public void received(Channel channel, Object message) throws RemotingException {
        ExecutorService executor = getExecutorService();
        if (message instanceof Request) { // 1
            try {
                executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.RECEIVED, message));
            } catch (Throwable t) {
                if (t instanceof RejectedExecutionException) {
                    Request request = (Request) message;
                    if (request.isTwoWay()) {
                        String msg = "Server side(" + url.getIp() + "," + url.getPort()
                                + ") thread pool is exhausted, detail msg:" + t.getMessage();
                        Response response = new Response(request.getId(), request.getVersion());
                        response.setStatus(Response.SERVER_THREADPOOL_EXHAUSTED_ERROR);
                        response.setErrorMessage(msg);
                        channel.send(response);
                        return;
                    }
                }
                throw new ExecutionException(message, channel, getClass() + " error when process received event.", t);
            }
        } else {
            handler.received(channel, message); // 2
        }
    }
}
{% endhighlight %}

1. 在线程池中执行消息类型是请求的消息。
2. 响应消息由`handler`所在的IO线程池执行。既不是响应也不是请求消息的消息处理方法则使用`WrappedChannelHandler`中定义的处理方法，默认有IO线程处理。

### MessageOnlyDispatcher

`message`分派策略和`execution`类似，只不过`message`会将请求和响应消息都派发到线程池执行。`MessageOnlyDispatcher`实现了`message`分派器：

{% highlight java %}
public class MessageOnlyDispatcher implements Dispatcher {

    public static final String NAME = "message";

    @Override
    public ChannelHandler dispatch(ChannelHandler handler, URL url) {
        return new MessageOnlyChannelHandler(handler, url);
    }
}
{% endhighlight %}

`message`分派策略的具体实现在`MessageOnlyChannelHandler`装饰器中：

{% highlight java %}
public class MessageOnlyChannelHandler extends WrappedChannelHandler {

    public MessageOnlyChannelHandler(ChannelHandler handler, URL url) {
        super(handler, url);
    }

    @Override
    public void received(Channel channel, Object message) throws RemotingException {
        ExecutorService executor = getExecutorService();
        try {
            executor.execute(new ChannelEventRunnable(channel, handler, ChannelState.RECEIVED, message));
        } catch (Throwable t) {
            throw new ExecutionException(message, channel, getClass() + " error when process received event .", t);
        }
    }
}
{% endhighlight %}

`MessageOnlyChannelHandler`实现逻辑很简单，将所有请求和响应消息都派发到线程池中执行，而其他消息则使用`WrappedChannelHandler`默认的实现，即使用IO线程处理。

## 线程池

前面我们介绍了Dubbo提供的各个分派策略的实现，各个分派策略将不同类型的消息分派到线程池执行。Dubbo中用于分派消息处理的线程池通过`ThreadPool`抽象，支持多种扩展实现，默认使用`fixed`线程池扩展。

{% highlight java %}
@SPI("fixed")
public interface ThreadPool {
    @Adaptive({THREADPOOL_KEY})
    Executor getExecutor(URL url);
}
{% endhighlight %}

在介绍`WrappedChannelHandler`的时候我们已经提到了，`ThreadPool`的具体实现在`WrappedChannelHandler`的构造方法中被扩展加载器`ExtensionLoader`在运行时加载。扩展加载器加载`ThreadPool`的时候使用`getAdaptiveExtension()`来加载自适应扩展。自适应扩展会基于Dubbo的配置动态返回需要的扩展。Dubbo通过`threadpool`参数配置需要被加载的线程池扩展是哪个。

Dubbo支持的线程池实现有4种，分别是`fixed`、`cached`、`limited`、`eager`，对应到`ThreadPool`实现：`FixedThreadPool`、`CachedTheadPool`、`LimitedThreadPool`以及`EagerThreadPool`。

### FixedThreadPool

{% highlight java %}
public class FixedThreadPool implements ThreadPool {
    @Override
    public Executor getExecutor(URL url) {
        String name = url.getParameter(THREAD_NAME_KEY, DEFAULT_THREAD_NAME);
        int threads = url.getParameter(THREADS_KEY, DEFAULT_THREADS);
        int queues = url.getParameter(QUEUES_KEY, DEFAULT_QUEUES);
        return new ThreadPoolExecutor(threads, threads, 0, TimeUnit.MILLISECONDS,
                queues == 0 ? new SynchronousQueue<Runnable>() :
                        (queues < 0 ? new LinkedBlockingQueue<Runnable>()
                                : new LinkedBlockingQueue<Runnable>(queues)),
                new NamedInternalThreadFactory(name, true), new AbortPolicyWithReport(name, url));
    }
}
{% endhighlight %}

Dubbo定义的`fixed`线程池扩展是一个固定大小的线程池，对应`FixedThreadPool`实现使用了JUC中的`ThreadPoolExecutor`，将核心线程数和最大线程数设置为固定的值`threads`，这个固定值可以被配置，通过参数`threads`设置，默认值为200。

线程池的队列长度通过参数`queues`进行配置，默认值为0。当任务队列的长度为0的时候，线程池使用`SynchronousQueue`同步队列来实现任务队列。如果队列的长度值被设置为负值，则使用`LinkedBlockingQueue`实现的无界队列，如果队列长度是正值，则使用`LinkedBlockingQueue`的有界实现。

### CachedThreadPool

{% highlight java %}
public class CachedThreadPool implements ThreadPool {
    @Override
    public Executor getExecutor(URL url) {
        String name = url.getParameter(THREAD_NAME_KEY, DEFAULT_THREAD_NAME);
        int cores = url.getParameter(CORE_THREADS_KEY, DEFAULT_CORE_THREADS);
        int threads = url.getParameter(THREADS_KEY, Integer.MAX_VALUE);
        int queues = url.getParameter(QUEUES_KEY, DEFAULT_QUEUES);
        int alive = url.getParameter(ALIVE_KEY, DEFAULT_ALIVE);
        return new ThreadPoolExecutor(cores, threads, alive, TimeUnit.MILLISECONDS,
                queues == 0 ? new SynchronousQueue<Runnable>() :
                        (queues < 0 ? new LinkedBlockingQueue<Runnable>()
                                : new LinkedBlockingQueue<Runnable>(queues)),
                new NamedInternalThreadFactory(name, true), new AbortPolicyWithReport(name, url));
    }
}
{% endhighlight %}

`CachedTheadPool`实现了`cached`线程池方案。`cached`线程池的行为和JUC中的`Executors.newCachedThreadPool()`实现类似，支持线程的动态扩展和收缩。可以通过参数`corethreads`配置核心线程数，默认值为`0`，最大线程数可以通过`threads`配置，默认值为int的最大值`Integer.MAX_VALUE`。空闲线程的存活时间通过参数`alive`控制，默认时间为60秒。

线程池的队列配置策略和`FixedThreadPool`一样，通过`queues`参数进行设置。具体使用哪种队列实现可以参考上面介绍的`FixedThreadPool`，这里不再赘述。

### LimitedThreadPool

{% highlight java %}
public class LimitedThreadPool implements ThreadPool {
    @Override
    public Executor getExecutor(URL url) {
        String name = url.getParameter(THREAD_NAME_KEY, DEFAULT_THREAD_NAME);
        int cores = url.getParameter(CORE_THREADS_KEY, DEFAULT_CORE_THREADS);
        int threads = url.getParameter(THREADS_KEY, DEFAULT_THREADS);
        int queues = url.getParameter(QUEUES_KEY, DEFAULT_QUEUES);
        return new ThreadPoolExecutor(cores, threads, Long.MAX_VALUE, TimeUnit.MILLISECONDS,
                queues == 0 ? new SynchronousQueue<Runnable>() :
                        (queues < 0 ? new LinkedBlockingQueue<Runnable>()
                                : new LinkedBlockingQueue<Runnable>(queues)),
                new NamedInternalThreadFactory(name, true), new AbortPolicyWithReport(name, url));
    }
}
{% endhighlight %}

`LimitedThreadPool`实现了`limited`线程池方案，`LimitedThreadPool`的实现和`CachedTheadPool`类似，区别的点在于对空闲线程的存活时间设置：`LimitedThreadPool`设置的存活时间为long整形的最大值`Long.MAX_VALUE`，这是一个很大的值，在时间度量上可以认为是永远。所以`LimitedThreadPool`的线程池实现不会对线程池中的线程进行回收，它自会增长不回收。除了这点和`CachedThreadPool`不一样以外，其他的实现和`CachedTheadPool`一致。

### EagerThreadPool

{% highlight java %}
public class EagerThreadPool implements ThreadPool {

    @Override
    public Executor getExecutor(URL url) {
        String name = url.getParameter(THREAD_NAME_KEY, DEFAULT_THREAD_NAME);
        int cores = url.getParameter(CORE_THREADS_KEY, DEFAULT_CORE_THREADS);
        int threads = url.getParameter(THREADS_KEY, Integer.MAX_VALUE);
        int queues = url.getParameter(QUEUES_KEY, DEFAULT_QUEUES);
        int alive = url.getParameter(ALIVE_KEY, DEFAULT_ALIVE);

        // init queue and executor
        TaskQueue<Runnable> taskQueue = new TaskQueue<Runnable>(queues <= 0 ? 1 : queues);
        EagerThreadPoolExecutor executor = new EagerThreadPoolExecutor(cores,
                threads,
                alive,
                TimeUnit.MILLISECONDS,
                taskQueue,
                new NamedInternalThreadFactory(name, true),
                new AbortPolicyWithReport(name, url));
        taskQueue.setExecutor(executor);
        return executor;
    }
}
{% endhighlight %}

`EagerThreadPool`是对`eager`线程池扩展的实现，`EagerThreadPool`使用的Dubbo自定义的线程池实现`EagerThreadPoolExecutor`。`EagerThreadPoolExecutor`是对`ThreadPoolExecutor`的扩展，继承了`CachedTheadPool`并重写了`CachedTheadPool`的`execute()`方法以实现自己的线程分配策略。同时为了实现`eager`的优先创建工作线程的策略，Dubbo自定义了任务队列实现`TaskQueue`用于处理队列排队策略。

`EagerThreadPoolExecutor`配合`TaskQueue`实现了先增长工作线程后入队的线程池分配行为，下面我们来看下他们是如何实现的。首先看下`EagerThreadPoolExecutor`的实现：

{% highlight java %}
public class EagerThreadPoolExecutor extends ThreadPoolExecutor {
    private final AtomicInteger submittedTaskCount = new AtomicInteger(0); // 1

    public EagerThreadPoolExecutor(int corePoolSize,
                                   int maximumPoolSize,
                                   long keepAliveTime,
                                   TimeUnit unit, TaskQueue<Runnable> workQueue,
                                   ThreadFactory threadFactory,
                                   RejectedExecutionHandler handler) {
        super(corePoolSize, maximumPoolSize, keepAliveTime, unit, workQueue, threadFactory, handler);
    }
    
    public int getSubmittedTaskCount() {
        return submittedTaskCount.get();
    }

    @Override
    protected void afterExecute(Runnable r, Throwable t) { // 2
        submittedTaskCount.decrementAndGet();
    }

    @Override
    public void execute(Runnable command) {
        if (command == null) {
            throw new NullPointerException();
        }
        // do not increment in method beforeExecute!
        submittedTaskCount.incrementAndGet(); // 3
        try {
            super.execute(command); // 4
        } catch (RejectedExecutionException rx) {
            // retry to offer the task into queue.
            final TaskQueue queue = (TaskQueue) super.getQueue(); // 5
            try {
                if (!queue.retryOffer(command, 0, TimeUnit.MILLISECONDS)) { // 5
                    submittedTaskCount.decrementAndGet();
                    throw new RejectedExecutionException("Queue capacity is full.", rx);
                }
            } catch (InterruptedException x) {
                submittedTaskCount.decrementAndGet();
                throw new RejectedExecutionException(x);
            }
        } catch (Throwable t) {
            // decrease any way
            submittedTaskCount.decrementAndGet();
            throw t;
        }
    }
}
{% endhighlight %}

1. `submittedTaskCount`记录被提交到线程池的任务数量，这里单独记录是为了在`execute()`方法中进行数量的增减控制。
2. `afterExecute()`方法是`ThreadPoolExecutor`中的钩子（Hook）方法，任务执行完成以后会触发该钩子方法。
3. 在开始执行前递增提交到线程池的任务计数。关于不在`beforeExecute()`方法中进行计数的原因等我们分析完下面的执行逻辑以后再回过来探讨。
4. 调用`ThreadPoolExecutor`的`execute()`方法执行任务。这里会按照`ThreadPoolExecutor`的线程分配策略进行任务调度，前面我们提到`EagerThreadPoolExecutor`和`ThreadPoolExecutor`的不同点就在于任务调度方式，`EagerThreadPoolExecutor`是先创建工作线程，直到不能再新增工作线程以后才入队，而`ThreadPoolExecutor`恰恰相反，它先入队后创建工作线程。那这里调用`ThreadPoolExecutor`的`execute()`方法是如何将这种分配策略变成`EagerThreadPoolExecutor`期望的那种分配方式呢？答案就在Dubbo自定义的`TaskQueue`中。

#### TaskQueue
Dubbo自定义了一个`LinkedBlockingQueue`实现`TaskQueue`来配合`EagerThreadPoolExecutor`实现`eager`线程调度策略。

{% highlight java %}
public class TaskQueue<R extends Runnable> extends LinkedBlockingQueue<Runnable> {
    private EagerThreadPoolExecutor executor;

    public TaskQueue(int capacity) {
        super(capacity);
    }

    public void setExecutor(EagerThreadPoolExecutor exec) {
        executor = exec;
    }

    @Override
    public boolean offer(Runnable runnable) { // 1
        if (executor == null) {
            throw new RejectedExecutionException("The task queue does not have executor!");
        }

        int currentPoolThreadSize = executor.getPoolSize();
        // have free worker. put task into queue to let the worker deal with task.
        if (executor.getSubmittedTaskCount() < currentPoolThreadSize) { // 2
            return super.offer(runnable);
        }

        // return false to let executor create new worker.
        if (currentPoolThreadSize < executor.getMaximumPoolSize()) { // 3
            return false;
        }

        // currentPoolThreadSize >= max
        return super.offer(runnable); // 4
    }

    public boolean retryOffer(Runnable o, long timeout, TimeUnit unit) throws InterruptedException {
        if (executor.isShutdown()) {
            throw new RejectedExecutionException("Executor is shutdown!");
        }
        return super.offer(o, timeout, unit);
    }
}

{% endhighlight %}

1. `TaskQueue`是`LinkedBlockingQueue`的一个实现，它重写了`offer()`方法用于实现自定义的入队操作。
2. 当`EagerThreadPoolExecutor`线程池中已提交的任务数量小于线程池的核心线程池数的时候调用`LinkedBlockingQueue`的`offer()`实现。
3. 如果线程池当前的线程数比最大线程数小，`offer()`返回`false`。
4. 如果线程池当前的线程数超过最大线程线程数，则返回`false`。

你可能会疑惑，为什么`offer()`方法的返回值的逻辑是这样的？因为Dubbo重写的`offer()`方法的逻辑是和`ThreadPoolExecutor`线程分配策略紧密相关的。在分析为什么这么返回前，我们先来看下`ThreadPoolExecutor`是如何调度任务的。

{% highlight java %}
public void execute(Runnable command) {
    if (command == null)
        throw new NullPointerException();
        
    int c = ctl.get();
    if (workerCountOf(c) < corePoolSize) { // 1
        if (addWorker(command, true))
            return;
        c = ctl.get();
    }
    if (isRunning(c) && workQueue.offer(command)) { // 2
        int recheck = ctl.get();
        if (! isRunning(recheck) && remove(command))
            reject(command);
        else if (workerCountOf(recheck) == 0)
            addWorker(null, false);
    }
    else if (!addWorker(command, false)) // 3
        reject(command);
}
{% endhighlight %}

1. 如果当前线程池中的线程数小于核心线程数`corePoolSize`，则调用`addWorker()`新增工作线程。
2. 如果当前线程池中的线程数等于或者超过了核心线程数，则尝试调用`workQueue`的`offer()`方法入队，如果`offer()`方法返回`true`则不新增工作线程（当前有至少一个工作线程存在的情况下）。
3. 如果`offer()`返回`false`则新增工作线程。

*注：这里我们只分析了`execute()`的主要逻辑，关于具体的细节可以参考[《ThreadPoolExecutor实现原理》](/2019/10/02/ThreadPoolExecutor实现原理#提交任务)这篇文章*

简单的理解，队列的`offer()`方法的返回值反应到`ThreadPoolExecutor`的行为就是：如果入队成功（返回`true`）则不增加工作线程；如果入队失败（返回`false`）则新增工作线程，直到达到最大线程数。现在，我们回到`TaskQueue`的`offer()`方法的实现中，这个时候再来理解为什么当线程池中的工作线程数量小于最大线程数的时候要返回`false`，其实就是为了让`EagerThreadPoolExecutor`可以利用上面提到的`ThreadPoolExecutor`的线程分配逻辑新增工作线程，以实现`EagerThreadPoolExecutor`先创建工作线程后入队列的任务调度策略。

至于为什么在工作线程超过最大线程的时候也返回`false`，是为了让`ThreadPoolExecutor`的`addWorker()`在队列还未满的时候抛出`RejectedExecutionException`异常，然后在`EagerThreadPoolExecutor`的`execute()`方法中捕获这个异常，异常处理程序执行`TaskQueue`的`retryOffer()`进行入队操作（见`EagerThreadPoolExecutor.execute()`的标记5）。

至此，Dubbo通过队列的`offer()`方法配合上`ThreadPoolExecutor`的任务调度策略实现了`eager`先创建工作线程后入队列的分配方式。

最后，还有一个问题我们没有讲：为什么`EagerThreadPoolExecutor`不在`beforeExecute()`钩子方法中新增提交任务数？如果你了解了上面`ThreadPoolExecutor`任务调度的策略和`beforeExecute()`的执行时机，那么这里就很好理解了。`beforeExecute()`钩子方法是在真正执行任务的时候被调用的，所以`beforeExecute()`和任务提交实际上不是同一个时间点。可能任务提交了，但是还未被线程池中的线程执行，导致在`TaskQueue.offer()`中`executor.getSubmittedTaskCount()`获取到的提交任务数不一致。极端情况下`ThreadPoolExecutor`的新`Worker`已经创建了，但是分配的任务（`firstTask`）还未被执行，这个时候如果正好达到核心线程数，那么在`beforeExecute()`中递增的提交任务数会比实际提交任务数少，导致在判断`executor.getSubmittedTaskCount() < currentPoolThreadSize`的时候返回`true`（实际上应该是`false`），进而导致任务被入队，而由于`EagerThreadPoolExecutor`是先创建工作线程后入队的，这个意外入队的任务会一直得不到执行而导致饥饿。

## 总结

本文介绍了Dubbo中关于线程模型的实现，Dubbo通过对`ChannelHandler`进行装饰来实现消息的不同分配策略，通过`ThreadPool`实现了不同线程池的灵活扩展。


[^1]:[https://en.wikipedia.org/wiki/Decorator_pattern](https://en.wikipedia.org/wiki/Decorator_pattern)
