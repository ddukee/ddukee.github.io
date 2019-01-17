---
layout: post
title:  ThreadContext类加载器
date:   2018-06-10 20:35:00 +0800
categories: programing-language
tags: java classloader
published: true
---

## 疑惑
以前在看源码的时候，总是会遇到框架里的代码使用`Thread.currentThread.getContextClassLoader()`获取当前线程的Context类加载器，通过这个Context类加载器去加载类。

我们平时在程序中写代码的时候，遇到要动态加载类的时候，一般使用`Class.forName()`的方式加载我们需要的类。比如最常见的，当我们进行JDBC编程的时候，我们通过`Class.forName()`去加载JDBC的驱动。

{% highlight java %}
try {
    return Class.forName("oracle.jdbc.driver.OracleDriver");
} catch (ClassNotFoundException e) {
    // skip
}
{% endhighlight %}

那么为什么当我们使用`Class.forName()`的方式去加载类的时候，如果类找不到，我们还要尝试用`Thread.currentThread.getContextLoader()`获取的类加载器去加载类呢？比如我们可能会碰到下面这种代码：

{% highlight java %}
try {
    return Class.forName(className);
} catch (ClassNotFoundException e) {
    // skip
}

ClassLoader ctxClassLoader = Thread.currentThread().getContextClassLoader();
if (ctxClassLoader != null) {
    try {
    clazz = ctxClassLoader.loadClass(className);
    } catch (ClassNotFoundException e) {
        // skip
    }
}
{% endhighlight %}

这里使用了`Thread.currentThread.getContextLoader()`获取的加载器去加载类。显然，`Class.forName()`加载类的时候使用的类加载器可能和`Thread.currentThread.getContextLoader()`获取的类加载器是不同的。那么为什么会出现不同呢？

## JAVA的类加载器
要理解为什么会用到`Thread.currentThread.getContextLoader()`获取的这个类加载器之前，我们先来了解下JVM里使用的类加载器（ClassLoader）。

JVM默认有三种类加载器：

1. Bootstrap Class Loader
2. Extension Class Loader
3. System Class Loader

### Bootstrap Class Loader
**Bootstrap Class Loader** 类加载器是JDK自带的一款类加载器，用于加载JDK内部的类。Bootstrap类加载器用于加载JDK中`$JAVA_HOME/jre/lib`下面的那些类，比如 **rt.jar** 包里面的类。Bootstrap类加载器是JVM的一部分，一般采用native代码编写。

### Extension Class Loader
**Extension Class Loader** 类加载器主要用于加载JDK扩展包里的类。一般`$JAVA_HOME/lib/ext`下面的包都是通过这个类加载器加载的，这个包下面的类基本上是以 **javax** 开头的。

### System Class Loader
**System Class Loader** 类加载器也叫应用程序类加载器(AppClassLoader)。顾名思义，这个类加载器就是用来加载开发人员自己平时写的应用代码的类的。System类加载器是用于加载存放在 **classpath** 路径下的那些应用程序级别的类的。

下面的代码列举出了这三个类加载器：

{% highlight java %}
public static void main(String[] args) {
    System.out.println(Integer.class.getClassLoader());
    System.out.println(Logging.class.getClassLoader());
    System.out.println(MainClass.class.getClassLoader());
}
{% endhighlight %}

其中获取Bootstrap类加载器永远返回 **null** 值

{% highlight text %}
$ java Main
null # Bootstrap类加载器
sun.misc.Launcher$ExtClassLoader@5e2de80c # Extension类加载器
sun.misc.Launcher$AppClassLoader@18b4aac2 # System类加载器
{% endhighlight %}

## 双亲委派模型
上面介绍的三种类加载器，并不是孤立的，他们之间有层次关系：

![双亲委派](/assets/images/双亲委派_1.png){:width="33%" height="33%"}

三个类加载器之间通过这个层次关系协同工作，一起负责类的加载工作。上面的这种层次模型称为类加载器的“双亲委派”模型。双亲委派模型要求，除了最顶层的Bootstrap类加载器之外，所有的类加载器都必须有一个parent加载器。**当类加载器加载类的时候，首先检查缓存中是否有已经被加载的类。如果没有，则优先委托它的父加载器去加载这个类，父加载器执行和前面子加载器一样的工作，直到请求达到顶层的Bootstrap类加载器。如果父加载器不能加载需要的类，那么这个时候才会让子加载器自己去尝试加载这个类。** 工作原理类似于下面这种方式。

![类加载过程](/assets/images/双亲委派_2.png){:width="40%" height="40%"}

我们可以通过JDK里ClassLoader里面的代码一窥双亲委派机制的实现方式，代码实现在`ClassLoader.loadClass()`里面

{% highlight java %}
protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
   synchronized (getClassLoadingLock(name)) {
       // First, check if the class has already been loaded
       Class<?> c = findLoadedClass(name);
       if (c == null) {
           long t0 = System.nanoTime();
           try {
               if (parent != null) {
                   c = parent.loadClass(name, false);
               } else {
                   c = findBootstrapClassOrNull(name);
               }
           } catch (ClassNotFoundException e) {
               // ClassNotFoundException thrown if class not found
               // from the non-null parent class loader
           }

           if (c == null) {
               // If still not found, then invoke findClass in order
               // to find the class.
               long t1 = System.nanoTime();
               c = findClass(name);

               // this is the defining class loader; record the stats
               sun.misc.PerfCounter.getParentDelegationTime().addTime(t1 - t0);
               sun.misc.PerfCounter.getFindClassTime().addElapsedTimeFrom(t1);
               sun.misc.PerfCounter.getFindClasses().increment();
           }
       }
       if (resolve) {
           resolveClass(c);
       }
       return c;
   }
}
{% endhighlight %}

采用双亲委派的方式组织类加载器，一个好处是为了安全。如果我们自己定义了一个 **String** 类，希望将这个 **String** 类替换掉默认Java中的 **java.lang.String** 的实现。

我们将自己实现的 **String** 类的class文件放到 **classpath** 路径下，当我们使用类加载器去加载我们实现的 **String** 类的时候，首先，类加载器会将请求委托给父加载器，通过层层委派，最终由Bootstrap类加载器加载 **rt.jar** 包里的 **String** 类型，然后一路返回给我们。在这个过程中，我们的类加载器忽略掉了我们放在 **classpath** 中自定义的String类。

如果没有采用双亲委派机制，那么System类加载器可以在 **classpath** 路径中找到String的class文件并加载到程序中，导致JDK中的 **String** 实现被覆盖。所以类加载器的这种工作方式，在一定程度上保证了Java程序可以安全稳定的运行。

## ThreadContext类加载器

上面讲了那么多类加载器相关的内容，可还是没有讲到今天的主题：**线程上下文类加载器（Thread Context ClassLoader）**。

到这里，我们已经知道Java提供了三种类加载器，并且按照严格的双亲委派机制协同工作。表面上，似乎很完美，但正是这种严格的双亲委派机制导致在加载类的时候，存在一些局限性。

当我们更加基础的框架需要用到应用层面的类的时候，只有当这个类是在我们当前框架使用的类加载器可以加载的情况下我们才能用到这些类。换句话说，我们不能使用当前类加载器的子加载器加载的类。这个限制就是双亲委派机制导致的，因为类加载请求的委派是单向的。

虽然这种情况不多，但是还是会有这种需求。比较典型的，JNDI服务。JNDI提供了查询资源的接口，但是具体实现由不同的厂商实现。这个时候，**JNDI** 的代码是由JVM的Bootstrap类加载器加载，但是具体的实现是用户提供的JDK之外的代码，所以只能由System类加载器或者其他用户自定义的类加载器去加载，在双亲委派的机制下，JNDI获取不到JNDI的SPI的实现。

为了解决这个问题，引入了线程上下文类加载器。通过 **java.lang.Thread** 类的`setContextClassLoader()`设置当前线程的上下文类加载器（如果没有设置，默认会从父线程中继承，如果程序没有设置过，则默认是System类加载器）。有了线程上下文类加载器，应用程序就可以通过`java.lang.Thread.setContextClassLoader()`将应用程序使用的类加载器传递给使用更顶层类加载器的代码。比如上面的JNDI服务，就可以利用这种方式获取到可以加载SPI实现的类加载器，获取需要的SPI实现类。

![上下文类加载过程](/assets/images/双亲委派_3.png){:width="45%" height="45%"}

可以看到，引入线程类加载器实际是对双亲委派机制的破坏，但是却提供了类加载的灵活性。

## 解惑
回到开头，框架的代码为了加载框架之外用户实现的类，由于这些类可能没法通过框架使用的类加载器进行加载，为了绕过类加载器的双亲委派模型，采用`Thread.getContextClassLoader()`的方式去加载这些类。